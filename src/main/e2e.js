'use strict';

/**
 * 离线端到端联调（--e2e）。
 *
 * 目的：在没有平台账号的环境里，把「解析 → 展示 → 勾选 → 下载 → 实况转 MP4 →
 * 失败标记 → 重试入口」整条链路真实跑一遍，并留下截图与文件证据。
 * 平台解析结果由本地假数据提供，下载走真实的 HTTP + 真实文件落盘 + 真实 ffmpeg。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const hooks = require('./testhooks');
const { ffmpegPath, probe } = require('./media');

const log = (...args) => process.stdout.write(args.join(' ') + '\n');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造真实媒体文件并起一个支持 Range 的本地服务 */
async function startFixtureServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutu-e2e-'));
  const bin = ffmpegPath();
  const files = {};

  files['photo1.jpg'] = path.join(dir, 'photo1.jpg');
  files['photo2.jpg'] = path.join(dir, 'photo2.jpg');
  files['clip.mp4'] = path.join(dir, 'clip.mp4');
  files['live.mov'] = path.join(dir, 'live.mov');

  if (bin) {
    const ff = (args) => execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x2b2b2b:s=800x1000', '-frames:v', '1', files['photo1.jpg']]);
    ff(['-f', 'lavfi', '-i', 'color=c=0xffd7e1:s=800x1000', '-frames:v', '1', files['photo2.jpg']]);
    ff(['-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', files['clip.mp4']]);
    ff(['-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', files['live.mov']]);
  }

  const stats = { requests: 0, ranges: [] };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const url = req.url.split('?')[0];
    stats.ranges.push(req.headers.range || '');
    if (url === '/missing.jpg') {
      res.writeHead(404);
      return res.end();
    }
    const name = url.replace('/', '');
    const file = files[name];
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    const buf = fs.readFileSync(file);
    const type = name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.mov') ? 'video/quicktime' : 'image/jpeg';
    const m = /bytes=(\d+)-/.exec(String(req.headers.range || ''));
    if (m) {
      const start = Number(m[1]);
      const slice = buf.subarray(start);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
      });
      return res.end(slice);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stats,
    files,
    ffmpeg: !!bin,
    close: () => new Promise((r) => server.close(r)),
  };
}

let preparedDir = null;

/** 在窗口创建前调用：把下载目录固定到临时目录，避免污染用户真实目录 */
function prepare(store) {
  preparedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutu-e2e-out-'));
  store.set({ downloadDir: preparedDir, concurrency: 3 });
  return preparedDir;
}

async function run({ win, store }) {
  const report = { ok: true, steps: [], checks: [] };
  const check = (name, pass, detail) => {
    report.checks.push({ name, pass: !!pass, detail });
    if (!pass) report.ok = false;
  };

  const srv = await startFixtureServer();
  const outDir = preparedDir || prepare(store);
  const shots = path.join(os.tmpdir(), 'tutu-e2e-shots');
  fs.mkdirSync(shots, { recursive: true });

  // 卡片封面用 data URI：既绕开 CSP（测试站点是 http），也能看到真实缩略图
  const dataUri = (f) => (f && fs.existsSync(f) ? 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64') : '');
  const cover1 = dataUri(srv.files['photo1.jpg']);
  const cover2 = dataUri(srv.files['photo2.jpg']);

  const items = [
    {
      id: 'e2e_img_1',
      platform: 'xhs',
      type: 'image',
      title: '两条美图',
      author: '兔兔酱',
      cover: cover1,
      pageUrl: 'https://www.xiaohongshu.com/explore/e2e_img_1',
      assets: [
        { kind: 'image', url: `${srv.base}/photo1.jpg`, still: `${srv.base}/photo1.jpg`, ext: '' },
        { kind: 'image', url: `${srv.base}/photo2.jpg`, still: `${srv.base}/photo2.jpg`, ext: '' },
      ],
    },
    {
      id: 'e2e_vid_2',
      platform: 'xhs',
      type: 'video',
      title: '一段视频',
      author: '兔兔酱',
      cover: cover2,
      assets: [{ kind: 'video', url: `${srv.base}/clip.mp4`, still: `${srv.base}/photo2.jpg`, ext: 'mp4' }],
    },
    {
      id: 'e2e_live_3',
      platform: 'xhs',
      type: 'live',
      title: '一张实况图',
      author: '兔兔酱',
      cover: cover1,
      assets: [{ kind: 'live', url: `${srv.base}/live.mov`, still: `${srv.base}/photo1.jpg`, ext: 'mov' }],
    },
    {
      id: 'e2e_bad_4',
      platform: 'xhs',
      type: 'image',
      title: '一个坏链接',
      author: '兔兔酱',
      assets: [{ kind: 'image', url: `${srv.base}/missing.jpg` }],
    },
  ];

  hooks.fakeParse = async () => {
    await sleep(120);
    // liveCount 模拟解析阶段识别出的 Live 实况图数量（第八轮新增）
    return {
      ok: true,
      items,
      author: '兔兔酱',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/e2e',
      loggedIn: true,
      liveCount: 1,
    };
  };

  // 下载前会先「补一次详情」来识别实况图。离线 E2E 用的是本地假地址，
  // 真去打开平台详情页会白白耗掉几十秒（还会因为网络波动让断言忽好忽坏），
  // 这里直接把详情阶段短路掉：假数据本来就是最终形态。
  hooks.fakeDetails = async ({ items: given }) => ({ items: given, failed: [] });

  // 记录所有「打开目录/文件」的调用：用来验证下载完成后不再自动弹出下载目录
  const openedPaths = [];
  hooks.openPath = (target) => openedPaths.push(String(target));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const p = path.join(shots, name);
    fs.writeFileSync(p, img.toPNG());
    report.steps.push({ step: name, shot: p });
  };

  try {
    // ---- 1. 解析 ----
    await js(`document.querySelector('#urlInput').value='https://www.xiaohongshu.com/user/profile/e2e';
      document.querySelector('#fieldWrap').classList.add('has-value');
      document.querySelector('#btnParse').click(); 1`);
    await sleep(900);
    const gridCount = await js("document.querySelectorAll('#workGrid .card').length");
    check('解析后作品卡片数量为 4', gridCount === 4, `got ${gridCount}`);
    const subText = await js("document.querySelector('#pgSub').textContent");
    check('作者与作品数展示正确', /兔兔酱/.test(subText), subText);
    check('副标题标注 Live 实况图数量', /含 1 个 Live 实况图/.test(subText), subText);
    // 作品卡片上要能看出哪些是实况图（解析阶段识别出来的）
    const liveBadge = await js(`(() => {
      const cards = [...document.querySelectorAll('#workGrid .card')];
      const c = cards.find(x => x.textContent.includes('一张实况图'));
      if (!c) return 'no-card';
      const b = c.querySelector('.card-badge');
      return b ? b.textContent.trim() : 'no-badge';
    })()`);
    check('实况图作品卡片带「实况」徽标', /实况/.test(String(liveBadge)), String(liveBadge));
    await shot('01-parsed.png');

    // ---- 2. 全选 ----
    await js("document.querySelector('#btnSelectAll').click(); 1");
    await sleep(200);
    const selInfo = await js("document.querySelector('#selInfo').textContent");
    check('全选后计数为 3..4', /4/.test(selInfo), selInfo);
    const btnDisabled = await js("document.querySelector('#btnDownload').disabled");
    check('下载按钮已启用', btnDisabled === false);
    await shot('02-selected.png');

    // ---- 3. 下载 ----
    await js("document.querySelector('#btnDownload').click(); 1");
    // 等待主进程跑完（最多 30s）
    const deadline = Date.now() + 30000;
    let finished = false;
    while (Date.now() < deadline) {
      await sleep(400);
      const state = await js("JSON.stringify({downloading: window.__tutuState ? 1 : 0})");
      const tasks = await js("document.querySelectorAll('#taskList .task').length");
      const done = await js("document.querySelectorAll('#taskList .task .task-ico.ok, #taskList .task .task-ico.err').length");
      if (tasks >= 4 && done >= 4) {
        finished = true;
        break;
      }
      if (!state) break;
    }
    check('4 个任务全部结束', finished);
    await shot('03-tasks.png');

    // ---- 3.5 下载完成后不再自动打开目录（第八轮要求）----
    await sleep(800);
    check('下载完成后没有自动打开下载目录', openedPaths.length === 0, `opened=${JSON.stringify(openedPaths)}`);
    const doneStatus = await js("document.querySelector('#statusText').textContent");
    check('下载完成后保留完成提示', /下载完成/.test(doneStatus), doneStatus);

    // ---- 4. 文件校验 ----
    const platformDir = path.join(outDir, '小红书', '兔兔酱');
    check('按平台/作者建目录', fs.existsSync(platformDir), platformDir);
    const albums = fs.existsSync(platformDir) ? fs.readdirSync(platformDir) : [];
    const findAlbum = (key) => albums.find((a) => a.includes(key));
    const imgAlbum = findAlbum('e2e_img_1');
    const imgFiles = imgAlbum ? fs.readdirSync(path.join(platformDir, imgAlbum)).sort() : [];
    check('图集导出 2 张图', imgFiles.length === 2 && imgFiles.every((f) => f.endsWith('.jpg')), imgFiles.join(','));

    const vidAlbum = findAlbum('e2e_vid_2');
    const vidFiles = vidAlbum ? fs.readdirSync(path.join(platformDir, vidAlbum)) : [];
    check('视频导出为 mp4', vidFiles.some((f) => f.endsWith('.mp4')), vidFiles.join(','));

    const liveAlbum = findAlbum('e2e_live_3');
    const liveFiles = liveAlbum ? fs.readdirSync(path.join(platformDir, liveAlbum)) : [];
    check('实况图导出为 mp4（原 mov 已被无损封装）', liveFiles.length === 1 && liveFiles[0].endsWith('.mp4'), liveFiles.join(','));
    if (liveFiles.length) {
      const info = await probe(path.join(platformDir, liveAlbum, liveFiles[0]));
      check('实况视频保留原始分辨率 720x1280', info && info.width === 720 && info.height === 1280, JSON.stringify(info));
      check('实况视频编码为 h264（未重编码）', info && info.codec === 'h264', info && info.codec);
    }

    const badAlbum = findAlbum('e2e_bad_4');
    const badStatus = await js(`(() => {
      const el = [...document.querySelectorAll('#taskList .task')].find(t => t.textContent.includes('一个坏链接'));
      return el ? el.querySelector('.task-ico').className : 'missing';
    })()`);
    check('坏链接标记为失败', /err/.test(badStatus), badStatus);
    check('失败作品未产生残缺文件', !badAlbum || fs.readdirSync(path.join(platformDir, badAlbum)).length === 0, badAlbum || 'no dir');

    const retryVisible = await js("!document.querySelector('#btnRetryFailed').classList.contains('hidden')");
    check('出现「重试失败项」入口', retryVisible);

    // ---- 5. 重试（仍会失败，但流程不能崩） ----
    await js("document.querySelector('#btnRetryFailed').click(); 1");
    await sleep(2500);
    const stillAlive = await js("!!document.querySelector('#btnDownload')");
    check('重试后界面仍然可用', stillAlive);
    await shot('04-retry.png');

    // ---- 6. 设置面板 ----
    await js("document.querySelector('#btnSettings').click(); 1");
    await sleep(300);
    const sheetOpen = await js("!document.querySelector('#settingsSheet').classList.contains('hidden')");
    check('设置面板可打开', sheetOpen);
    await shot('05-settings.png');
    await js("document.querySelector('#sheetClose').click(); 1");
  } finally {
    await srv.close();
  }

  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter((c) => c.pass).length,
    failed: report.checks.filter((c) => !c.pass).length,
    outDir,
  };
  log('E2E_RESULT=' + JSON.stringify(report));
  setTimeout(() => process.exit(report.ok ? 0 : 2), 400);
}

module.exports = { run, prepare };
