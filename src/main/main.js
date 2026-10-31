'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');

const platforms = require('./platforms');
const U = require('./platforms/util');
const { BrowserHost } = require('./browser-host');
const { ProfileParser } = require('./parser');
const { Downloader } = require('./downloader');
const { Store } = require('./store');
const { ffmpegPath } = require('./media');
const hooks = require('./testhooks');

const isDev = !app.isPackaged;
const SMOKE = process.argv.includes('--smoke-test');
/** 自动化验证模式：用独立的隐藏窗口，绝不能在用户窗口里多挂一个内嵌页 */
const TEST_MODE = process.argv.some((a) => /^--(verify|probe|net-test|settings-test)/.test(a));

let win = null;
let store = null;
let downloader = null;
const hosts = new Map(); // platformId -> BrowserHost
const parsers = new Map();
const stopFlags = new Map();
let activePlatform = '';

/**
 * 自动化脚本入口。
 * 正常模式下由 ready-to-show 触发（此时窗口已显示），
 * 验证模式下由 createWindow 直接触发（窗口保持隐藏，只当视图容器）。
 */
function runAutomation() {
  if (!win || win.isDestroyed()) return;
  if (process.argv.some((a) => a.startsWith('--verify'))) {
    // eslint-disable-next-line global-require
    require('./verify').run({ win });
  }
  if (process.argv.some((a) => a.startsWith('--net-test='))) {
    // eslint-disable-next-line global-require
    require('./nettest').run({ win });
  }
  if (process.argv.some((a) => a.startsWith('--probe='))) {
    // eslint-disable-next-line global-require
    require('./dev-probe').run({ win });
  }
}


app.setName('兔兔下载器');
app.setAppUserModelId('com.tutu.downloader');
// 固定 userData 目录。不固定的话：开发运行（electron.exe）会落在 %APPDATA%\Electron，
// 安装版落在 %APPDATA%\兔兔下载器 —— 两边的单实例锁互不可见，
// 于是同一个应用能同时开两个窗口，界面上看起来就像「两个小红书页面叠在一起」。
app.setPath('userData', path.join(app.getPath('appData'), '兔兔下载器'));

// 验证模式要和用户正在用的实例共存（两边共用一个 userData 才能复用已登录的 Cookie），
// 所以验证进程不参与单实例锁，否则它会被正在运行的正常实例直接踢掉。
let okToRun = true;
// TUTU_NO_LOCK：自动化脚本要跟用户正在运行的实例并存，跳过单实例锁（只给测试用）
if (!TEST_MODE && !process.env.TUTU_NO_LOCK) {
  const gotLock = app.requestSingleInstanceLock();
  okToRun = gotLock;
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }
}

/**
 * 设置持久化自检（--settings-test）。
 * 只读写 settings.json，不开窗口：配合两次独立启动，就能证明「保存后重启仍生效」。
 *   node tools/launch.js . --settings-test
 *   TUTU_SET_DIR=... node tools/launch.js . --settings-test
 */
function runSettingsTest() {
  const out = {
    file: store.file,
    exists: fs.existsSync(store.file),
    downloadDir: store.get('downloadDir'),
    concurrency: store.get('concurrency'),
  };
  if (process.env.TUTU_SET_DIR) {
    store.set({ downloadDir: process.env.TUTU_SET_DIR });
    out.afterSet = store.get('downloadDir');
    out.fileAfterSet = JSON.parse(fs.readFileSync(store.file, 'utf8')).downloadDir;
  }
  process.stdout.write('SETTINGS_RESULT=' + JSON.stringify(out) + '\n', () => app.exit(0));
}

function iconPath() {
  const p = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  // 双保险：任何路径都不允许出现第二个主窗口
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  // 窗口不要超出屏幕：小屏笔记本上按可用工作区收窄，否则右侧面板会被裁掉
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1220, Math.max(960, wa.width - 40));
  const height = Math.min(840, Math.max(640, wa.height - 60));

  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1000, width),
    minHeight: Math.min(660, height),
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#EEF1F6',
    icon: iconPath(),
    title: '兔兔下载器',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 验证模式：窗口只作为内嵌视图的容器，永远不显示、也不加载界面，
  // 否则测试脚本会在用户正在使用的窗口里再挂一个平台页，看起来就是「两个页面叠在一起」。
  if (TEST_MODE) {
    setTimeout(runAutomation, 250);
    return;
  }

  // 注意：Windows 上不要开 setBackgroundMaterial('acrylic')。
  // 半透明背景 + WebContentsView 子视图在 DWM 合成下会留下上一帧的残影
  // （同一个页面被画成上下两份），去掉后彻底没有了。毛玻璃观感由界面 CSS 负责。
  if (process.platform === 'darwin') {
    try { win.setVibrancy('under-window'); } catch {}
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE) runSmoke();
    runAutomation();
    const shotArg = process.argv.find((a) => a.startsWith('--shot='));
    if (shotArg && process.env.TUTU_SHOT_SERIES) {
      // 连续抓几帧，用于确认启动阶段有没有「旧画面没清掉」的重影
      const dir = path.dirname(shotArg.slice('--shot='.length));
      const marks = (process.env.TUTU_SHOT_SERIES || '3000,8000,15000,24000').split(',').map(Number);
      marks.forEach((ms, i) => {
        setTimeout(async () => {
          try {
            await captureScreen(path.join(dir, `series-${i + 1}.png`));
            const info = {
              at: ms,
              windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, bounds: w.getBounds(), visible: w.isVisible() })),
              children: win.contentView.children.length,
              hosts: [...hosts.entries()].map(([id, h]) => ({ id, visible: h.visible, bounds: h.bounds })),
            };
            process.stdout.write('SERIES ' + i + ' ' + JSON.stringify(info) + '\n');
          } catch (e) {
            process.stdout.write('SERIES_FAIL ' + String(e && e.message) + '\n');
          }
          if (i === marks.length - 1) setTimeout(() => app.exit(0), 300);
        }, ms);
      });
      return;
    }
    if (shotArg) {
      const target = shotArg.slice('--shot='.length);
      const waitMs = Number((process.argv.find((a) => a.startsWith('--shot-wait=')) || '--shot-wait=6000').split('=')[1]);
      if (process.env.TUTU_SHOT_RESIZE) {
        const [w0, h0] = win.getSize();
        setTimeout(() => win.setSize(w0 - 140, h0 - 80), Math.max(1200, waitMs - 6000));
        setTimeout(() => win.setSize(w0, h0), Math.max(1800, waitMs - 3500));
      }
      if (process.env.TUTU_SHOT_SWITCH) {
        const click = (pid) => win.webContents
          .executeJavaScript(`document.querySelector('.nav-item[data-pid="${pid}"]')?.click()`)
          .catch(() => {});
        setTimeout(() => click('weibo'), Math.max(1000, waitMs - 10000));
        setTimeout(() => click('xhs'), Math.max(1500, waitMs - 6000));
      }
      if (process.env.TUTU_TEST_VIEWTOOLS) {
        // 自动化验证网页面板右侧的「全屏预览」按钮
        setTimeout(async () => {
          const out = {};
          const js = (s) => win.webContents.executeJavaScript(s).catch(() => null);
          const slot = "(() => { const r = document.querySelector('#browserSlot').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()";
          const hostBox = () => (activeHost() ? activeHost().bounds : null);
          try {
            out.slot0 = await js(slot);
            out.host0 = hostBox();
            // 「放大」和「分栏」按钮已移除，只留全屏预览
            out.toolButtons = await js(
              "[...document.querySelectorAll('.view-tools .vt')].map(b => b.id).join(',')"
            );

            await js("document.querySelector('#btnViewFull').click(); 1");
            await new Promise((r) => setTimeout(r, 1500));
            out.fullClass = await js("document.querySelector('.workarea').className");
            out.slotFull = await js(slot);
            out.hostFull = hostBox();

            // Esc 退出全屏预览
            await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); 1");
            await new Promise((r) => setTimeout(r, 1200));
            out.restored = await js("document.querySelector('.workarea').className");
            out.slotRestored = await js(slot);
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          process.stdout.write('VIEWTOOLS_RESULT=' + JSON.stringify(out) + '\n');
        }, Math.max(2000, waitMs - 20000));
      }

      if (process.env.TUTU_CLICK_CARD) {
        // 自动化验证「点作品 → 右侧跳到该作品」
        setTimeout(async () => {
          const out = {};
          try {
            if (process.env.TUTU_CARD_PLATFORM) {
              await win.webContents
                .executeJavaScript(`document.querySelector('.nav-item[data-pid="${process.env.TUTU_CARD_PLATFORM}"]')?.click(); 1`)
                .catch(() => {});
              await new Promise((r) => setTimeout(r, 2500));
            }
            const host = activeHost();
            out.before = host ? host.webContents.getURL() : '';
            let cards = await win.webContents.executeJavaScript("document.querySelectorAll('#workGrid .card').length").catch(() => 0);
            // 还没有作品就先点一次「开始解析」（需要提前把主页链接填进输入框）
            if (!cards && process.env.TUTU_CLICK_CARD_URL) {
              await win.webContents.executeJavaScript(`(() => {
                const i = document.querySelector('#urlInput');
                if (i) { i.value = ${JSON.stringify(process.env.TUTU_CLICK_CARD_URL)}; i.dispatchEvent(new Event('input', { bubbles: true })); }
                document.querySelector('#btnParse')?.click();
                return 1;
              })()`).catch(() => {});
              for (let i = 0; i < 130 && !cards; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                cards = await win.webContents.executeJavaScript("document.querySelectorAll('#workGrid .card').length").catch(() => 0);
              }
            }
            out.cards = cards;
            out.cardTitle = await win.webContents.executeJavaScript("document.querySelector('#workGrid .card .card-title')?.textContent || ''").catch(() => '');
            out.cardUrl = await win.webContents.executeJavaScript("document.querySelector('#workGrid .card')?.dataset.url || ''").catch(() => '');
            const host0 = activeHost();
            out.hostBefore = host0 ? host0.webContents.getURL() : '';
            out.hostTitleBefore = host0 ? host0.webContents.getTitle() : '';
            out.hostVisibleBefore = host0 ? host0.visible : null;
            await win.webContents.executeJavaScript("document.querySelector('#workGrid .card')?.click(); 1").catch(() => {});
            await new Promise((r) => setTimeout(r, 6000));
            const host1 = activeHost();
            out.hostAfter = host1 ? host1.webContents.getURL() : '';
            out.hostTitleAfter = host1 ? host1.webContents.getTitle() : '';
            out.hostVisibleAfter = host1 ? host1.visible : null;
            out.platformAfter = host1 ? host1.platform.id : '';
            out.previewing = await win.webContents.executeJavaScript("document.querySelectorAll('#workGrid .card.previewing').length").catch(() => -1);
            out.bpTitle = await win.webContents.executeJavaScript("document.querySelector('#bpTitle')?.textContent || ''").catch(() => '');
            // 页面里到底有没有「详情」结构，判断是否真的换了内容（不只是 URL 变了）
            out.detail = host1
              ? await host1.webContents
                  .executeJavaScript(`(() => ({
                    video: document.querySelectorAll('video').length,
                    noteBox: document.querySelectorAll('#noteContainer, .note-content, .WB_detail, [data-e2e="detail-video"], [data-e2e="note-detail"]').length,
                    h1: ((document.querySelector('h1') || {}).textContent || '').slice(0, 40),
                  }))()`)
                  .catch(() => null)
              : null;
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          process.stdout.write('CARD_RESULT=' + JSON.stringify(out) + '\n');
        }, process.env.TUTU_CLICK_CARD_URL ? 6000 : Math.max(2000, waitMs - 6000));
      }

      if (process.env.TUTU_INPAGE_URL) {
        // 自动化验证「内嵌页一键解析按钮」：打开指定主页 → 点页面里的按钮 → 看侧栏是否开始解析
        setTimeout(async () => {
          const out = {};
          try {
            const pid = (platforms.detect(process.env.TUTU_INPAGE_URL) || { id: 'xhs' }).id;
            out.platform = pid;
            // 先切到该平台，否则会把微博地址加载进小红书的分区里
            await win.webContents
              .executeJavaScript(`document.querySelector('.nav-item[data-pid="${pid}"]')?.click()`)
              .catch(() => {});
            await new Promise((r) => setTimeout(r, 2500));
            const host = activeHost();
            out.hostPlatform = host.platform.id;
            await host.load(process.env.TUTU_INPAGE_URL, { timeout: 40000, force: true });
            await new Promise((r) => setTimeout(r, 3500));
            out.url = host.webContents.getURL();
            out.buttonFound = await host.eval("!!document.getElementById('__tutu_parse_btn')");
            out.buttonText = await host.eval("(document.getElementById('__tutu_parse_btn')||{}).textContent || ''");
            await host.eval("(() => { const b = document.getElementById('__tutu_parse_btn'); if (b) b.click(); return 1; })()");
            await new Promise((r) => setTimeout(r, 4000));
            out.status = await win.webContents.executeJavaScript("document.querySelector('#statusText')?.textContent || ''").catch(() => '');
            out.step = await win.webContents.executeJavaScript("document.querySelector('.step.on')?.dataset.step || ''").catch(() => '');
            out.input = await win.webContents.executeJavaScript("document.querySelector('#urlInput')?.value || ''").catch(() => '');
            out.parsing = await win.webContents.executeJavaScript("!!document.querySelector('#btnStop') && !document.querySelector('#btnStop').classList.contains('hidden')").catch(() => '');
            out.cardCount = await win.webContents.executeJavaScript("document.querySelectorAll('.card').length").catch(() => '');
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          process.stdout.write('INPAGE_RESULT=' + JSON.stringify(out) + '\n');
        }, Math.max(1500, waitMs - 15000));
      }

      if (process.env.TUTU_TEST_SWITCH) {
        // 验证「切平台后副标题/状态条不会留着上一个平台的数据」
        setTimeout(async () => {
          const out = {};
          const js = (s) => win.webContents.executeJavaScript(s).catch(() => null);
          try {
            let cards = await js("document.querySelectorAll('#workGrid .card').length");
            if (!cards && process.env.TUTU_CLICK_CARD_URL) {
              await js(`(() => {
                const i = document.querySelector('#urlInput');
                if (i) { i.value = ${JSON.stringify(process.env.TUTU_CLICK_CARD_URL)}; i.dispatchEvent(new Event('input', { bubbles: true })); }
                document.querySelector('#btnParse')?.click();
                return 1;
              })()`);
              for (let i = 0; i < 65 && !cards; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                cards = await js("document.querySelectorAll('#workGrid .card').length");
              }
            }
            out.cardsBefore = cards;
            out.subBefore = await js("document.querySelector('#pgSub')?.textContent || ''");
            out.statusBefore = await js("document.querySelector('#statusText')?.textContent || ''");
            await js("document.querySelector('.nav-item[data-pid=\"weibo\"]')?.click(); 1");
            await new Promise((r) => setTimeout(r, 4000));
            out.activeNav = await js("document.querySelector('.nav-item.on')?.dataset.pid || ''");
            out.subAfter = await js("document.querySelector('#pgSub')?.textContent || ''");
            out.statusAfter = await js("document.querySelector('#statusText')?.textContent || ''");
            out.stepAfter = await js("document.querySelector('.step.on')?.dataset.step || ''");
            out.emptyTitle = await js("document.querySelector('#emptyState .empty-title')?.textContent || ''");
            out.cardsAfter = await js("document.querySelectorAll('#workGrid .card').length");
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          process.stdout.write('SWITCH_RESULT=' + JSON.stringify(out) + '\n');
        }, process.env.TUTU_CLICK_CARD_URL ? 8000 : Math.max(2000, waitMs - 6000));
      }

      if (process.env.TUTU_COMPARE) {
        // 对比「左侧解析出来的作品顺序」与「右侧网页里实际渲染的作品顺序」
        setTimeout(async () => {
          const out = {};
          const js = (s) => win.webContents.executeJavaScript(s).catch(() => null);
          try {
            let cards = await js("document.querySelectorAll('#workGrid .card').length");
            if (!cards && process.env.TUTU_COMPARE_URL) {
              await js(`(() => {
                const i = document.querySelector('#urlInput');
                if (i) { i.value = ${JSON.stringify(process.env.TUTU_COMPARE_URL)}; i.dispatchEvent(new Event('input', { bubbles: true })); }
                document.querySelector('#btnParse')?.click();
                return 1;
              })()`);
              for (let i = 0; i < 80 && !cards; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                cards = await js("document.querySelectorAll('#workGrid .card').length");
              }
            }
            // 左侧：按 DOM 顺序（= 界面从上到下从左到右）取 id 与标题
            out.left = await js(`(() => [...document.querySelectorAll('#workGrid .card')].map((c, i) => ({
              i: i + 1,
              id: c.dataset.id || '',
              u: c.dataset.url || '',
              title: (c.querySelector('.card-title') || {}).textContent || '',
            })))()`);

            // 右侧：取内嵌页里所有作品链接，按「视觉位置」排序（先上后下、同排先左后右）
            const host = activeHost();
            if (host && process.env.TUTU_COMPARE_SCROLL) {
              // 页面是懒渲染的，先把右侧滚到底把作品都渲出来，才能做全量 1:1 比对
              for (let i = 0; i < Number(process.env.TUTU_COMPARE_SCROLL); i++) {
                await host.scrollStep(0.9).catch(() => {});
                await new Promise((r) => setTimeout(r, 1200));
              }
              await host.scrollToTop().catch(() => {});
              await new Promise((r) => setTimeout(r, 800));
            }
            out.hostUrl = host ? host.webContents.getURL() : '';
            out.hostTitle = host ? host.webContents.getTitle() : '';
            out.listUrls = host && host.sniffer && host.sniffer.urls
              ? host.sniffer.urls.filter((u) => /user_posted|mymblog|aweme\/post/.test(u)).slice(-6).map((u) => String(u).slice(0, 160))
              : [];
            out.hostAuthor = host
              ? await host.webContents
                  .executeJavaScript("(document.querySelector('.user-name, .user-nickname, #userPageContainer .user-name')||{}).textContent || ''")
                  .catch(() => '')
              : '';
            const raw = host
              ? await host.webContents
                  .executeJavaScript(`(() => {
                    const pats = [/\\/explore\\/([0-9a-f]{20,})/, /\\/discovery\\/item\\/([0-9a-f]{20,})/,
                      /weibo\\.com\\/\\d+\\/([A-Za-z0-9]{8,10})/, /\\/(?:video|note)\\/(\\d{15,25})/];
                    const seen = new Map();
                    document.querySelectorAll('a[href]').forEach((a) => {
                      const h = a.getAttribute('href') || '';
                      for (const p of pats) {
                        const m = h.match(p);
                        if (m) {
                          if (!seen.has(m[1])) {
                            const r = a.getBoundingClientRect();
                            const holder = a.closest('[mid], [data-mid]');
                            const alt = holder ? (holder.getAttribute('mid') || holder.getAttribute('data-mid') || '') : '';
                            seen.set(m[1], { id: m[1], alt, href: h.slice(0, 120),
                              text: (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 60),
                              top: Math.round(r.top + window.scrollY), left: Math.round(r.left) });
                          }
                          break;
                        }
                      }
                    });
                    return [...seen.values()];
                  })()`)
                  .catch(() => [])
              : [];
            // 同一行 top 允许 8px 抖动，先按行再按 left 排
            const rows = new Map();
            raw.forEach((r) => {
              const key = Math.round(r.top / 8);
              if (!rows.has(key)) rows.set(key, []);
              rows.get(key).push(r);
            });
            const visual = [...rows.keys()]
              .sort((a, b) => a - b)
              .flatMap((k) => rows.get(k).sort((a, b) => a.left - b.left));

            const mkIdx = (arr) => {
              const m = new Map();
              arr.forEach((x, j) => {
                if (typeof x === 'string') { m.set(x, j + 1); return; }
                m.set(x.id, j + 1);
                if (x.alt) m.set(x.alt, j + 1); // 微博：链接是 mblogid，左侧 id 是 mid
              });
              return m;
            };
            const cmp = (idxMap) => {
              const tail = (u) => (String(u || '').split('?')[0].split('/').filter(Boolean).pop() || '');
              const pairs = (out.left || []).map((l) => ({
                i: l.i,
                r: idxMap.get(l.id) || idxMap.get(tail(l.u)) || 0,
                t: l.title.slice(0, 26),
              }));
              const hit = pairs.filter((p) => p.r > 0);
              const breaks = [];
              for (let i = 1; i < hit.length; i++) {
                if (hit[i].r <= hit[i - 1].r) breaks.push({ leftIdx: hit[i].i, rightIdx: hit[i].r, prevRightIdx: hit[i - 1].r, title: hit[i].t });
                if (breaks.length >= 6) break;
              }
              return { pairs, matched: hit.length, monotonic: hit.every((p, i) => i === 0 || p.r > hit[i - 1].r), breaks };
            };
            out.leftCount = (out.left || []).length;
            out.rightCount = raw.length;
            out.dom = cmp(mkIdx(raw)); // 文档顺序（grid 渲染顺序）
            out.visual = cmp(mkIdx(visual)); // 视觉顺序（先上后下、同排先左后右）
            const leftIds = new Set((out.left || []).map((l) => l.id));
            out.extraOnRight = raw.filter((r) => !leftIds.has(r.id)).map((r) => r.id).slice(0, 10);
            out.singlePair = out.leftCount === 1 && out.rightCount === 1; // 微博/抖音测试号只有 1 条，天然 1:1
            out.missingOnRight = out.dom.pairs.filter((p) => !p.r).slice(0, 6);
            out.sample = raw.slice(0, 4).map((r) => ({ id: r.id.slice(0, 10), top: r.top, left: r.left }));
            delete out.left;
          } catch (e) {
            out.error = String((e && e.stack) || e);
          }
          process.stdout.write('COMPARE_RESULT=' + JSON.stringify(out) + '\n');
        }, process.env.TUTU_COMPARE_URL ? 6000 : Math.max(2000, waitMs - 6000));
      }

      if (process.env.TUTU_AUDIT) {
        // 体检：解析数量 vs 页面显示数量；点作品是否真的换页；实况图下载后是否产出 mp4
        setTimeout(async () => {
          const out = { platform: process.env.TUTU_AUDIT_PLATFORM || '' };
          const js = (s) => win.webContents.executeJavaScript(s).catch(() => null);
          try {
            if (process.env.TUTU_AUDIT_PLATFORM) {
              await js(`document.querySelector('.nav-item[data-pid="${process.env.TUTU_AUDIT_PLATFORM}"]')?.click(); 1`);
              await new Promise((r) => setTimeout(r, 2500));
            }
            let cards = await js("document.querySelectorAll('#workGrid .card').length");
            if (!cards && process.env.TUTU_AUDIT_URL) {
              await js(`(() => {
                const i = document.querySelector('#urlInput');
                if (i) { i.value = ${JSON.stringify(process.env.TUTU_AUDIT_URL)}; i.dispatchEvent(new Event('input', { bubbles: true })); }
                document.querySelector('#btnParse')?.click();
                return 1;
              })()`);
              for (let i = 0; i < 90 && !cards; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                cards = await js("document.querySelectorAll('#workGrid .card').length");
                const tst = await js("[...document.querySelectorAll('.toast')].map(t=>t.textContent.trim()).join(' | ')");
                if (tst) out.lastToast = tst;
              }
            }
            out.cards = cards;
            out.toastNow = await js("[...document.querySelectorAll('.toast')].map(t=>t.textContent.trim()).join(' | ')");
            out.badges = await js(`(() => {
              const m = {};
              document.querySelectorAll('#workGrid .card .card-badge').forEach((b) => {
                const t = (b.textContent || '').trim();
                m[t] = (m[t] || 0) + 1;
              });
              return m;
            })()`);
            out.sub = await js("document.querySelector('#pgSub')?.textContent || ''");
            out.status = await js("document.querySelector('#statusText')?.textContent || ''");

            // 页面自己标称的数量
            const host = activeHost();
            out.hostUrl = host ? host.webContents.getURL() : '';
            out.pageText = host
              ? await host.webContents
                  .executeJavaScript(`(() => {
                    const t = String(document.body.innerText || '').replace(/\\s+/g, ' ');
                    const pick = (label) => {
                      const m = new RegExp('(' + label + ')\\\\s*([0-9]+(?:\\\\.[0-9]+)?\\\\s*[万w]?)').exec(t);
                      return m ? m[2] : '';
                    };
                    return JSON.stringify({
                      note: pick('笔记'), work: pick('作品'), weibo: pick('微博'),
                      follow: pick('关注'), fans: pick('粉丝'), like: pick('获赞'),
                      sample: t.slice(0, 200),
                    });
                  })()`)
                  .catch(() => '')
              : '';

            if (process.env.TUTU_AUDIT_DL) {
              const want = process.env.TUTU_AUDIT_DL;
              // 渲染层的下载目录是启动时读的，这里改 store 不会生效，
              // 所以直接下到用户目录，事后把这次测试产生的文件夹删掉。
              const root0 = store.get('downloadDir');
              out.auditDir = root0;
              out.picked = await js(`(() => {
                const cards = [...document.querySelectorAll('#workGrid .card')];
                const pick = cards.find((c) => ((c.querySelector('.card-badge') || {}).textContent || '').trim() === ${JSON.stringify(want)}) || cards[0];
                if (!pick) return null;
                const chk = pick.querySelector('.check');
                if (chk) chk.click();
                return {
                  title: ((pick.querySelector('.card-title') || {}).textContent || '').slice(0, 40),
                  badge: ((pick.querySelector('.card-badge') || {}).textContent || '').trim(),
                  id: pick.dataset.id || '',
                  url: pick.dataset.url || '',
                };
              })()`);
              await new Promise((r) => setTimeout(r, 900));
              await js("document.querySelector('#btnDownload')?.click(); 1");
              await new Promise((r) => setTimeout(r, 1200));
              // 选中后按钮要重渲染一次才可点，没点着就再点一次
              const t0 = (await js("document.querySelector('#btnDownload')?.textContent || ''")) || '';
              out.btnFirst = t0;
              if (!/下载中/.test(t0)) {
                await js("document.querySelector('#btnDownload')?.click(); 1");
                await new Promise((r) => setTimeout(r, 1200));
              }
              // 等下载结束（按钮文案从「下载中…」变回「下载选中」）
              let last = '';
              for (let i = 0; i < 240; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                last = (await js("document.querySelector('#btnDownload')?.textContent || ''")) || '';
                if (i > 3 && !/下载中/.test(last)) break;
              }
              out.btnAfter = last;
              out.badgeAfter = await js(`(() => {
                const id = ${JSON.stringify((out.picked && out.picked.id) || '')};
                const c = id ? document.querySelector('#workGrid .card[data-id="' + id + '"]') : null;
                return c ? ((c.querySelector('.card-badge') || {}).textContent || '').trim() : '';
              })()`);
              out.tasks = await js(`(() => [...document.querySelectorAll('#taskList .task')].slice(0, 4).map((t) => (t.textContent || '').replace(/\\s+/g, ' ').slice(0, 120)))()`);

              // 找出这次下载落盘的文件
              const pathMod = require('path');
              const fsMod = require('fs');
              const { probe } = require('./media');
              const root = store.get('downloadDir');
              const found = [];
              const walk = (d, depth) => {
                if (depth > 6) return;
                let ents = [];
                try { ents = fsMod.readdirSync(d, { withFileTypes: true }); } catch { return; }
                for (const e of ents) {
                  const p = pathMod.join(d, e.name);
                  if (e.isDirectory()) walk(p, depth + 1);
                  else {
                    let st = null;
                    try { st = fsMod.statSync(p); } catch {}
                    found.push({ rel: pathMod.relative(root, p), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
                  }
                }
              };
              if (root) walk(root, 1);
              const recent = found.sort((a, b) => b.mtime - a.mtime).slice(0, 8);
              out.files = recent.map((f) => f.rel + ' | ' + f.size + 'B');
              const mp4 = recent.find((f) => /\.mp4$/i.test(f.rel));
              out.mp4 = mp4 ? mp4.rel : '';
              if (mp4) {
                try {
                  out.probe = await probe(pathMod.join(root, mp4.rel));
                } catch (e) {
                  out.probeError = String((e && e.message) || e);
                }
              }
              // 只保留 / 清理这次测试产生的那个作品文件夹
              try {
                const fsMod = require('fs');
                if (out.picked && out.picked.id) {
                  const hit = found.find((f) => f.rel.split(/[\\/]/).some((seg) => seg.includes(out.picked.id)));
                  if (hit) {
                    const parts = hit.rel.split(/[\\/]/);
                    const itemDir = pathMod.join(root0, ...parts.slice(0, -1));
                    out.itemDir = itemDir;
                    if (itemDir.startsWith(root0) && itemDir !== root0) {
                      fsMod.rmSync(itemDir, { recursive: true, force: true });
                      out.cleaned = true;
                    }
                  }
                }
              } catch (e) {
                out.cleanError = String((e && e.message) || e);
              }
            }
          } catch (e) {
            out.error = String((e && e.stack) || e);
          }
          process.stdout.write('AUDIT_RESULT=' + JSON.stringify(out) + '\n');
        }, process.env.TUTU_AUDIT_URL ? 5000 : Math.max(2000, waitMs - 6000));
      }
      setTimeout(async () => {
        try {
          // 截图前把窗口顶到最前，否则截到的是别的程序的窗口
          if (process.env.TUTU_SHOT_TOPMOST) {
            try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            await new Promise((r) => setTimeout(r, 900));
          }
          let cropRect = null;
          if (process.env.TUTU_SHOT_CROP) {
            if (win.isMinimized()) win.restore();
            const b = win.getBounds();
            // 最小化窗口在 Windows 上会返回 -32000 之类的哨兵坐标，这种就别裁了
            if (b.width > 200 && b.height > 200 && b.x > -10000 && b.y > -10000) cropRect = b;
          }
          await captureScreen(target, cropRect);
          const diag = {
            children: win.contentView.children.length,
            hosts: [...hosts.entries()].map(([id, h]) => ({ id, visible: h.visible, bounds: h.bounds, url: h.webContents.getURL().slice(0, 90) })),
            material: process.platform === 'darwin' ? 'vibrancy' : 'acrylic',
            size: win.getSize(),
            content: win.getContentBounds(),
          };
          process.stdout.write('SHOT_OK ' + target + ' ' + JSON.stringify(diag) + '\n');
        } catch (e) {
          process.stdout.write('SHOT_FAIL ' + String((e && e.message) || e) + '\n');
        }
        setTimeout(() => app.exit(0), 300);
      }, waitMs);
    }
    if (process.argv.includes('--e2e')) {
      // eslint-disable-next-line global-require
      require('./e2e').run({ win, store }).catch((e) => {
        process.stdout.write('E2E_RESULT=' + JSON.stringify({ ok: false, error: String((e && e.stack) || e) }) + '\n');
        setTimeout(() => app.exit(1), 300);
      });
    }
  });

  win.on('will-resize', () => {
    // 拖动窗口边缘连续改尺寸时先收起内嵌页面，避免 Windows 上留下拉伸中的残影
    const cur = activeHost();
    if (cur) cur.hide();
  });
  win.on('resize', () => syncHostBounds(true));
  win.on('resized', () => {
    const cur = activeHost();
    if (cur) cur.show();
  });
  win.on('closed', () => {
    for (const h of hosts.values()) h.destroy();
    hosts.clear();
    win = null;
  });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && isDev) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
}

/** 让内嵌页面贴合渲染层给的矩形 */
function syncHostBounds(useLast = false) {
  if (!win) return;
  const cur = currentHost();
  if (!cur) return;
  if (useLast && cur.bounds.width > 1) cur.setBounds(cur.bounds);
}

function currentHost() {
  for (const h of hosts.values()) if (h.visible) return h;
  return null;
}

/** 当前选中的平台（即使视图被临时收起也记得是谁） */
function activeHost() {
  if (activePlatform && hosts.has(activePlatform)) return hosts.get(activePlatform);
  return currentHost();
}

/**
 * 唯一允许「显示内嵌页」的入口：
 * 先把其他平台的视图全部收起，再显示目标这一个。
 * 任何新增的显示路径都必须走这里，避免两个平台页面同屏重叠。
 */
function showOnly(platformId) {
  for (const [id, h] of hosts) if (id !== platformId) h.hide();
  const host = getHost(platformId);
  activePlatform = platformId;
  host.show();
  return host;
}

function getHost(platformId) {
  let host = hosts.get(platformId);
  if (!host) {
    const adapter = platforms.get(platformId);
    host = new BrowserHost(win, adapter);
    host.sniffer.onError = (e) => console.warn('[sniffer]', e && e.message);
    // 页内登录成功后（跳转/局部刷新/轮询）把最新登录态推回界面，
    // 否则「已登录」要等到下次切换平台才更新，用户会以为没登上而反复登录
    host.onLoginMaybeChanged = async () => {
      const parser = parsers.get(platformId);
      if (!parser) return;
      const st = await parser.loginState().catch(() => null);
      if (!st) return;
      if (win && !win.isDestroyed()) {
        win.webContents.send('platform:ready', { platformId, loggedIn: st.cookie && !st.ui });
      }
    };
    hosts.set(platformId, host);
    parsers.set(platformId, new ProfileParser(host, adapter));
  }
  return host;
}

function getParser(platformId) {
  getHost(platformId);
  return parsers.get(platformId);
}

/** 缩略图需要平台 Referer，否则部分 CDN 直接 403 */
function installHeaderRules() {
  const rules = [
    { hosts: /(^|\.)xhscdn\.com$/i, referer: 'https://www.xiaohongshu.com/' },
    { hosts: /(^|\.)xiaohongshu\.com$/i, referer: 'https://www.xiaohongshu.com/' },
    { hosts: /(^|\.)sinaimg\.cn$/i, referer: 'https://weibo.com/' },
    { hosts: /(^|\.)douyinpic\.com$/i, referer: 'https://www.douyin.com/' },
    { hosts: /(^|\.)douyinstatic\.com$/i, referer: 'https://www.douyin.com/' },
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    try {
      const u = new URL(details.url);
      const hit = rules.find((r) => r.hosts.test(u.hostname));
      if (hit) {
        details.requestHeaders.Referer = hit.referer;
        details.requestHeaders['User-Agent'] =
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      }
    } catch {}
    cb({ requestHeaders: details.requestHeaders });
  });
}

/**
 * 平台 CDN 需要正确的 Referer，否则大量 403。
 * 注意：不能在 fetch 里直接塞 Referer（浏览器视为禁止头，会 ERR_BLOCKED_BY_CLIENT），
 * 必须在会话层注入。
 */
function installPlatformRules() {
  for (const p of platforms.list) {
    const s = session.fromPartition(`persist:tutu-${p.id}`);
    s.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      if (!h.Referer && !h.referer) h.Referer = p.referer;
      if (process.env.TUTU_DEBUG_HEADERS && /douyinvod|sinaimg|xhscdn/.test(details.url)) {
        process.stdout.write(`[hdr ${p.id}] ${String(details.url).slice(0, 70)} ref=${h.Referer || h.referer || '-'}\n`);
      }
      cb({ requestHeaders: h });
    });
  }
}

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    downloadDir: store.get('downloadDir'),
    concurrency: store.get('concurrency'),
    maxScrolls: store.get('maxScrolls'),
    detectLive: store.get('detectLive') !== false,
    ffmpeg: !!ffmpegPath(),
    platforms: platforms.meta,
    lastUrls: store.get('lastUrls'),
  }));

  ipcMain.handle('settings:set', (_e, patch) => store.set(patch || {}));

  ipcMain.handle('dialog:pick-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择保存位置',
      defaultPath: store.get('downloadDir'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    store.set({ downloadDir: res.filePaths[0] });
    return res.filePaths[0];
  });

  ipcMain.handle('platform:select', async (_e, platformId) => {
    const T0 = Date.now();
    const mark = (m) => { if (process.env.TUTU_DEBUG) process.stdout.write(`[select ${platformId}] ${m} @${Date.now() - T0}ms\n`); };
    mark('enter');
    const adapter = platforms.get(platformId);
    const host = showOnly(platformId);
    const parser = getParser(platformId);
    mark('host shown');
    const currentUrl = host.webContents.getURL();
    const ready = !!currentUrl && currentUrl !== 'about:blank';
    // 页面没加载完时状态未知：返回 null，等 platform:ready 事件再更新，避免误报
    const loggedIn = ready ? await parser.isLoggedIn() : null;
    mark('login checked: ' + loggedIn);
    if (!ready) {
      host
        .load(adapter.homeUrl, { timeout: 30000 })
        .then(async () => {
          const li = await parser.isLoggedIn().catch(() => false);
          if (win && !win.isDestroyed()) win.webContents.send('platform:ready', { platformId, loggedIn: li });
        })
        .catch(() => {});
    }
    mark('return');
    return { loggedIn, url: host.webContents.getURL(), lastUrl: store.get('lastUrls')[platformId] || '' };
  });

  ipcMain.handle('platform:bounds', (_e, rect) => {
    const host = currentHost();
    if (!host || !rect) return;
    host.setBounds(rect);
  });

  ipcMain.handle('platform:hide', () => {
    for (const h of hosts.values()) h.hide();
  });

  ipcMain.handle('platform:show', () => {
    const id = activePlatform || (currentHost() && currentHost().platform.id);
    if (id) showOnly(id);
  });

  ipcMain.handle('platform:reload', async (_e, platformId) => {
    const host = getHost(platformId);
    host.webContents.reload();
    return true;
  });

  ipcMain.handle('platform:home', async (_e, platformId) => {
    const adapter = platforms.get(platformId);
    const host = getHost(platformId);
    await host.load(adapter.homeUrl, { force: true }).catch(() => {});
    return true;
  });

  /**
   * 点左侧作品卡片 → 右侧内嵌页跳到这个作品。
   * 链接优先用列表里带权限参数的 pageUrl（小红书没有 xsec_token 会 404）。
   */
  ipcMain.handle('platform:preview', async (_e, { platformId, url, itemId }) => {
    const target = String(url || '');
    if (!platformId || !/^https?:/i.test(target)) return { ok: false, url: '' };
    const host = showOnly(platformId);
    const wc = host.webContents;
    const before = wc.getURL();

    const go = async (u) => {
      await host.load(u, { timeout: 30000, force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      return wc.getURL();
    };

    let after = await go(target);
    // 页面没动，或者还停在作者主页上（小红书会给出 /user/profile/<uid>/<id> 这种地址），
    // 换用平台的标准作品地址再试一次，别让用户觉得「点了没反应」。
    const sameTarget = target === before;
    const stuck = !sameTarget && (after === before || /\/user\/profile\/[\w]+\/?$/.test(after));
    if (stuck && itemId) {
      const adapter = platforms.get(platformId);
      const token = /[?&]xsec_token=([^&]+)/.exec(target);
      const canonical =
        typeof adapter.pageUrlFor === 'function'
          ? adapter.pageUrlFor(itemId, token ? decodeURIComponent(token[1]) : '')
          : '';
      if (canonical) after = await go(canonical);
    }
    return { ok: after !== before, url: after };
  });

  ipcMain.handle('platform:login-state', async (_e, platformId) => {
    const parser = getParser(platformId);
    const st = await parser.loginState();
    return { loggedIn: st.cookie && !st.ui, hasCookie: st.cookie, loginUi: st.ui };
  });

  ipcMain.handle('platform:parse', async (_e, { platformId, url }) => {
    const parser = getParser(platformId);
    const adapter = platforms.get(platformId);
    stopFlags.set(platformId, false);
    // 解析前确保视图在前台，页面才有真实尺寸（同时保证只有一个视图可见）
    const host = showOnly(platformId);
    const send = (payload) => win && win.webContents.send('parse:progress', { platformId, ...payload });
    try {
      const result = hooks.fakeParse
        ? await hooks.fakeParse({ platformId, url })
        : await parser.parseProfile(url, {
          onProgress: send,
          maxScrolls: store.get('maxScrolls') || 40,
          shouldStop: () => stopFlags.get(platformId) === true,
        });
      store.set({ lastUrls: { [platformId]: url } });
      send({ stage: 'done', message: `解析完成，共 ${result.items.length} 个作品`, count: result.items.length });
      return { ok: true, ...result, platformName: adapter.name };
    } catch (e) {
      const message = String((e && e.message) || e);
      send({ stage: 'error', message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('platform:stop', (_e, platformId) => {
    stopFlags.set(platformId, true);
    return true;
  });

  ipcMain.handle('platform:details', async (_e, { platformId, items, all }) => {
    const parser = getParser(platformId);
    stopFlags.set(platformId, false);
    if (hooks.fakeDetails) {
      const fake = await hooks.fakeDetails({ platformId, items });
      return { ok: true, items: fake.items || items, failed: fake.failed || [] };
    }
    try {
      const failed = await parser.resolveDetails(items, {
        onProgress: (p) => win && win.webContents.send('detail:progress', { platformId, ...p }),
        shouldStop: () => stopFlags.get(platformId) === true,
        all: !!all,
      });
      return { ok: true, items, failed };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), items, failed: [] };
    }
  });

  ipcMain.handle('download:start', async (_e, { platformId, items, dir }) => {
    const adapter = platforms.get(platformId);
    const rootDir = dir || store.get('downloadDir');
    if (downloader) downloader.cancel();
    downloader = new Downloader({
      rootDir,
      concurrency: store.get('concurrency'),
      getSession: (id) => session.fromPartition(`persist:tutu-${id}`),
      // CDN 偶发拒绝主进程直连时，用该平台页面自己请求兜底
      pageFallback: async (platformId, url) => {
        const h = hosts.get(platformId);
        return h ? h.fetchBytes(url) : null;
      },
      onEvent: (ev) => win && win.webContents.send('download:event', { platformId, ...ev }),
    });
    // 关掉「实况图导出为 MP4」时只下静图
    const exportLive = store.get('detectLive') !== false;
    const tasks = (items || []).map((item) => {
      // 「实况图导出为 MP4」关掉时，实况资产降级成静图（只下图片那半）。
      // 解析阶段照样会认出 Live 图并打上徽标 —— 认不认得出来和导不导出是两回事。
      if (!exportLive && item && item.assets && item.assets.some((a) => a.kind === 'live')) {
        const assets = U.downgradeLiveAssets(item.assets);
        return {
          item: { ...item, assets, type: assets.some((a) => a.kind === 'video') ? 'video' : 'image' },
          platform: adapter,
        };
      }
      return { item, platform: adapter };
    });
    const summary = await downloader.run(tasks);
    return { ok: true, ...summary, dir: rootDir };
  });

  ipcMain.handle('download:cancel', () => {
    if (downloader) downloader.cancel();
    return true;
  });

  ipcMain.handle('shell:open-path', async (_e, target) => {
    if (!target) return false;
    // E2E 用它统计「下载完成后有没有自动打开目录」
    if (hooks.openPath) {
      try { hooks.openPath(target); } catch {}
    }
    try {
      let p = target;
      if (!fs.existsSync(p)) p = path.dirname(p);
      const err = await shell.openPath(p);
      return !err;
    } catch {
      return false;
    }
  });

  ipcMain.handle('shell:open-url', async (_e, url) => {
    if (!/^https?:/i.test(String(url || ''))) return false;
    await shell.openExternal(url).catch(() => {});
    return true;
  });

  ipcMain.handle('window:control', (_e, action) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });

  ipcMain.handle('window:is-maximized', () => (win ? win.isMaximized() : false));

  // 内嵌页面里的「一键解析」按钮
  ipcMain.on('view:parse', (e) => {
    const sender = e.sender;
    let host = null;
    for (const h of hosts.values()) {
      if (h.webContents && h.webContents.id === sender.id) { host = h; break; }
    }
    if (!host || !win || win.isDestroyed()) return;
    const url = sender.getURL();
    const adapter = platforms.get(host.platform.id);
    const matched = adapter.matchUrl(url);
    win.webContents.send('view:parse-request', {
      platformId: host.platform.id,
      url,
      valid: !!matched,
    });
  });
}

/** 截整屏：用于确认内嵌浏览器（原生视图）真的显示出来了 */
async function captureScreen(target, cropRect) {
  const { desktopCapturer, screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  if (!sources.length) throw new Error('无法获取屏幕源');
  let img = sources[0].thumbnail;
  // 传了窗口矩形就裁掉桌面背景，只留应用自己（内嵌页是原生视图，只能整屏截）
  if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
    const full = img.getSize();
    const x = Math.max(0, Math.round((cropRect.x - display.bounds.x) * scale));
    const y = Math.max(0, Math.round((cropRect.y - display.bounds.y) * scale));
    const w = Math.min(Math.round(cropRect.width * scale), full.width - x);
    const h = Math.min(Math.round(cropRect.height * scale), full.height - y);
    if (w > 0 && h > 0) img = img.crop({ x, y, width: w, height: h });
  }
  fs.writeFileSync(target, img.toPNG());
  return target;
}

/** 启动自检：UI 截图 + 解析器夹具自检，供自动化验证使用 */
async function runSmoke() {  const out = { ok: true, steps: [] };
  try {
    const waitMs = Number(process.env.TUTU_SMOKE_WAIT || 1500);
    await new Promise((r) => setTimeout(r, waitMs));
    // 环境变量驱动时，顺带把界面状态打出来，便于自动化核对
    if (process.env.TUTU_SMOKE_WAIT) {
      const host = hosts.get('xhs');
      out.ui = {
        chip: await win.webContents.executeJavaScript("document.querySelector('#loginChip').textContent", true).catch(() => ''),
        step: await win.webContents.executeJavaScript("document.querySelector('.step.on')?.dataset.step || ''", true).catch(() => ''),
        hostUrl: host ? host.webContents.getURL() : '',
        viewVisible: host ? host.visible : false,
      };
    }
    const bounds = win.getContentBounds();
    const img = await win.webContents.capturePage();
    const shotDir = path.join(app.getPath('userData'), 'smoke');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = path.join(shotDir, 'main-window.png');
    fs.writeFileSync(shot, img.toPNG());
    out.steps.push({ step: 'window', ok: true, shot, size: bounds });
    out.ffmpeg = ffmpegPath() || null;
    out.platforms = platforms.meta.map((p) => p.id);
    process.stdout.write('SMOKE_RESULT=' + JSON.stringify(out) + '\n');
    setTimeout(() => app.quit(), 300);
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.stack) || e);
    process.stdout.write('SMOKE_RESULT=' + JSON.stringify(out) + '\n');
    setTimeout(() => app.quit(), 300);
  }
}

if (okToRun) {
  app.whenReady().then(() => {
    store = new Store(process.argv.includes('--e2e') ? 'settings.e2e.json' : 'settings.json');
    if (process.argv.includes('--e2e')) {
      // eslint-disable-next-line global-require
      require('./e2e').prepare(store);
    }
    if (process.argv.includes('--settings-test')) return runSettingsTest();
    installHeaderRules();
    installPlatformRules();
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    app.on('activate', () => {
      // macOS 点 Dock 图标时重建窗口；Windows 上不能再开新窗口
      if (process.platform === 'darwin' && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    for (const h of hosts.values()) h.destroy();
    hosts.clear();
    if (process.platform !== 'darwin') app.quit();
  });
}
