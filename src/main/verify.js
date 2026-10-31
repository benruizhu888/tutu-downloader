'use strict';

/**
 * 真实环境核验（--verify）。
 *
 * 逐平台执行：读登录态 → 从页面里找一个作者主页 → 解析作品 → 补详情 → 真下载 1 个文件。
 * 只读 + 只写临时目录，不动用户数据。
 *
 *   node tools/launch.js . --verify            # 三个平台
 *   node tools/launch.js . --verify=xhs        # 只测一个
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, session } = require('electron');

const { BrowserHost } = require('./browser-host');
const { ProfileParser } = require('./parser');
const platforms = require('./platforms');
const { Downloader } = require('./downloader');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const PROFILE_RE = {
  xhs: /^https?:\/\/www\.xiaohongshu\.com\/user\/profile\/[0-9a-zA-Z]+/,
  weibo: /^https?:\/\/weibo\.com\/(u\/)?\d{6,}/,
  douyin: /^https?:\/\/www\.douyin\.com\/user\/[0-9A-Za-z_-]{5,}/,
};

/** 从当前页面的链接里找作者主页；小红书优先取带 xsec_token 的（不带 token 会跳登录） */
async function findProfileUrl(host, adapter) {
  let hrefs = [];
  try {
    hrefs = await host.eval(`[...document.querySelectorAll('a[href]')].map(a => a.href).filter(Boolean)`);
  } catch {
    hrefs = [];
  }
  const re = PROFILE_RE[adapter.id];
  const hits = hrefs.filter((h) => re.test(h));
  if (adapter.id === 'xhs') {
    const withToken = hits.find((h) => h.includes('xsec_token='));
    if (withToken) return withToken;
  }
  return hits[0] || '';
}

/** 小红书首页的 __INITIAL_STATE__ 里带着「我是谁」，用自己的主页最稳 */
async function findSelfProfile(host) {
  try {
    const me = await host.eval(`(() => {
      const ui = ((window.__INITIAL_STATE__ || {}).user || {}).userInfo;
      return { id: String((ui && (ui.userId || ui.user_id)) || ''), nick: String((ui && ui.nickname) || '') };
    })()`);
    if (me && me.id) {
      return { url: `https://www.xiaohongshu.com/user/profile/${me.id}`, me };
    }
  } catch {}
  return null;
}

async function verifyPlatform(win, adapter, outDir) {
  const r = { platform: adapter.id, name: adapter.name, steps: [] };
  const host = new BrowserHost(win, adapter);
  const b = win.getContentBounds();
  host.setBounds({ x: Math.round(b.width * 0.55), y: 130, width: 430, height: 620 });
  host.show();
  const parser = new ProfileParser(host, adapter);

  try {
    await host.load(adapter.homeUrl, { timeout: 45000 });
    await sleep(3500);

    r.loggedIn = await parser.isLoggedIn();
    r.url = host.webContents.getURL();
    r.title = await host.eval('document.title').catch(() => '');
    r.cookieNames = (await host.session.cookies.get({})).map((c) => c.name).slice(0, 20);

    // 找作者主页（可用 TUTU_VERIFY_PROFILE 指定，便于稳定复测；
    // 也可以按平台指定 TUTU_VERIFY_PROFILE_DOUYIN / _WEIBO / _XHS）
    const perPlatform = process.env[`TUTU_VERIFY_PROFILE_${adapter.id.toUpperCase()}`];
    if (perPlatform) r.profileUrl = perPlatform;
    if (process.env.TUTU_VERIFY_PROFILE) {
      r.profileUrl = process.env.TUTU_VERIFY_PROFILE;
    }
    if (!r.profileUrl && adapter.id === 'xhs') {
      const self = await findSelfProfile(host);
      if (self) {
        r.me = self.me;
        r.profileUrl = self.url;
      }
    }
    if (!r.profileUrl) r.profileUrl = await findProfileUrl(host, adapter);
    // 首页是推荐流，作者链接不是每次都在首屏，多滚几次再判断
    for (let i = 0; i < 4 && !r.profileUrl; i++) {
      await host.scrollStep(0.85);
      await sleep(1600);
      r.profileUrl = await findProfileUrl(host, adapter);
    }
    if (adapter.id === 'xhs' && !r.profileUrl) {
      const self = await findSelfProfile(host);
      if (self) { r.me = self.me; r.profileUrl = self.url; }
    }
    if (!r.profileUrl) {
      r.error = '页面里没有找到作者主页链接';
      return r;
    }
    if (/\/user\/self|profile\/self/.test(r.profileUrl)) {
      await host.load(r.profileUrl, { timeout: 30000, force: true });
      await sleep(1500);
      r.profileUrl = host.webContents.getURL();
    }

    // 解析作品列表
    const res = await parser.parseProfile(r.profileUrl, {
      maxScrolls: 3,
      onProgress: (p) => { if (p.message && r.steps[r.steps.length - 1] !== p.message) r.steps.push(p.message); },
    });
    r.itemCount = res.items.length;
    r.author = res.author;
    r.types = res.items.reduce((acc, it) => { acc[it.type] = (acc[it.type] || 0) + 1; return acc; }, {});
    r.withAssets = res.items.filter((it) => it.assets && it.assets.length).length;
    r.sample = res.items.slice(0, 3).map((it) => ({
      id: it.id,
      title: String(it.title || '').slice(0, 24),
      type: it.type,
      assets: it.assets.length,
      cover: String(it.cover || '').slice(0, 80),
      pageUrl: String(it.pageUrl || '').slice(0, 120),
    }));

    // 补详情：挑前 3 个缺媒体的作品（可用 TUTU_VERIFY_PICK=video 指定类型）
    const pickType = process.env.TUTU_VERIFY_PICK || '';
    const pool = pickType ? res.items.filter((it) => it.type === pickType) : res.items;
    let target = pool.find((it) => it.assets && it.assets.length);
    if (!target && pool.length) {
      const probe = pool.slice(0, 3).filter(Boolean);
      const failed = await parser.resolveDetails(probe, { onProgress: () => {} });
      r.detail = {
        tried: probe.length,
        ok: probe.filter((it) => it.assets && it.assets.length).length,
        failed: failed.length,
        reasons: failed.map((f) => String(f.reason).slice(0, 120)).slice(0, 3),
      };
      target = probe.find((it) => it.assets && it.assets.length);
    }
    if (!target) {
      const dm = await host.detailDomMedia().catch(() => ({ images: [], videos: [] }));
      r.detailDebug = {
        currentUrl: host.webContents.getURL().slice(0, 160),
        domImages: dm.images.slice(0, 3).map((u) => u.slice(0, 100)),
        domVideos: dm.videos.slice(0, 3),
      };
      r.error = r.error || '详情解析后仍没有可下载的媒体';
      return r;
    }
    r.target = {
      id: target.id,
      type: target.type,
      assets: target.assets.map((a) => ({ kind: a.kind, url: String(a.url) })),
    };

    // 真下载一个文件
    const events = [];
    const dl = new Downloader({
      rootDir: outDir,
      concurrency: 1,
      getSession: (id) => session.fromPartition(`persist:tutu-${id}`),
      pageFallback: async (_pid, u) => host.fetchBytes(u),
      onEvent: (ev) => { if (events.length < 60) events.push(ev); },
    });
    r.download = await dl.run([{ item: target, platform: adapter }]);
    r.downloadEvents = events.filter((e) => e.stage !== 'progress').slice(-12);
    const dir = path.join(outDir, adapter.name, target.author || '未知作者');
    if (fs.existsSync(dir)) {
      const album = fs.readdirSync(dir)[0];
      if (album) {
        r.files = fs.readdirSync(path.join(dir, album)).map((f) => {
          const p = path.join(dir, album, f);
          return { name: f, bytes: fs.statSync(p).size };
        });
      }
    }
    r.ok = r.download.success > 0 && (r.files || []).length > 0 && (r.files || []).every((f) => f.bytes > 1024);
    if (!r.ok) r.error = r.error || '下载结果为空或文件过小';
  } catch (e) {
    r.error = String((e && e.message) || e);
  } finally {
    try { host.destroy(); } catch {}
  }
  return r;
}

async function run({ win }) {
  const arg = process.argv.find((a) => a.startsWith('--verify'));
  const only = arg.includes('=') ? arg.split('=')[1] : '';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutu-verify-'));
  const report = { at: new Date().toISOString(), outDir, results: [] };

  const list = platforms.list.filter((p) => !only || p.id === only);
  for (const p of list) {
    log(`[verify] ${p.name} 开始…`);
    const r = await verifyPlatform(win, p, outDir);
    report.results.push(r);
    log(`[verify] ${p.name} => ${JSON.stringify({
      loggedIn: r.loggedIn, items: r.itemCount, withAssets: r.withAssets, ok: r.ok, error: r.error || null,
    })}`);
  }

  report.summary = {
    total: report.results.length,
    loggedIn: report.results.filter((r) => r.loggedIn).length,
    parsed: report.results.filter((r) => r.itemCount > 0).length,
    ok: report.results.filter((r) => r.ok).length,
  };
  process.stdout.write('VERIFY_RESULT=' + JSON.stringify(report) + '\n', () => app.exit(0));
}

module.exports = { run };
