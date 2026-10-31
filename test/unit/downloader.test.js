'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { fetchToFile, Downloader, itemDir } = require('../../src/main/downloader');

const PAYLOAD = Buffer.alloc(120 * 1024, 7);

function tmpDir(prefix = 'tutu-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 起一个可控的本地服务，返回统计信息方便断言 */
function serve(handler) {
  const stats = { requests: 0, ranges: [], paths: [] };
  const server = http.createServer((req, res) => {
    stats.requests++;
    stats.ranges.push(req.headers.range || '');
    stats.paths.push(req.url);
    handler(req, res, stats);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        stats,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function sendFull(res, buf = PAYLOAD, type = 'image/jpeg') {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

function sendRange(req, res, buf = PAYLOAD, type = 'image/jpeg') {
  const m = /bytes=(\d+)-/.exec(String(req.headers.range || ''));
  if (!m) return sendFull(res, buf, type);
  const start = Number(m[1]);
  const slice = buf.subarray(start);
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': slice.length,
    'Content-Range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
  });
  res.end(slice);
}

test('正常下载：内容完整、无残留 .part、进度回调有终点', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => sendFull(res));
  const target = path.join(dir, '图片.jpg');
  const seen = [];
  const res = await fetchToFile(`${srv.base}/a.jpg`, target, {
    fetchImpl: (u, o) => fetch(u, o),
    onProgress: (n, total) => seen.push([n, total]),
  });
  await srv.close();

  assert.equal(fs.statSync(target).size, PAYLOAD.length);
  assert.equal(res.bytes, PAYLOAD.length);
  assert.ok(!fs.existsSync(target + '.part'));
  assert.ok(seen.length > 0);
  const last = seen[seen.length - 1];
  assert.equal(last[0], PAYLOAD.length);
  assert.equal(last[1], PAYLOAD.length);
});

test('断点续传：已有 .part 时只请求剩余字节', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => sendRange(req, res));
  const target = path.join(dir, '视频.mp4');
  const part = target + '.part';
  fs.writeFileSync(part, PAYLOAD.subarray(0, 40960));

  const res = await fetchToFile(`${srv.base}/v.mp4`, target, {
    fetchImpl: (u, o) => fetch(u, o),
  });
  await srv.close();

  assert.equal(srv.stats.ranges[0], 'bytes=40960-');
  assert.equal(res.bytes, PAYLOAD.length);
  assert.equal(fs.statSync(target).size, PAYLOAD.length);
  assert.ok(!fs.existsSync(part));
});

test('服务端不支持断点（返回 200）时，从头重写而不是拼接', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => sendFull(res));
  const target = path.join(dir, 'a.jpg');
  fs.writeFileSync(target + '.part', Buffer.alloc(5000, 1));

  const res = await fetchToFile(`${srv.base}/a.jpg`, target, {
    fetchImpl: (u, o) => fetch(u, o),
  });
  await srv.close();

  assert.equal(fs.statSync(target).size, PAYLOAD.length);
  assert.equal(res.bytes, PAYLOAD.length);
});

test('失败重试：连续 500 后成功', async () => {
  const dir = tmpDir();
  let count = 0;
  const srv = await serve((req, res) => {
    count++;
    if (count <= 2) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    sendFull(res);
  });
  const target = path.join(dir, 'retry.jpg');
  const res = await fetchToFile(`${srv.base}/r.jpg`, target, {
    fetchImpl: (u, o) => fetch(u, o),
  });
  await srv.close();

  assert.equal(srv.stats.requests, 3);
  assert.equal(res.bytes, PAYLOAD.length);
});

test('404 直接失败，不做无意义重试', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await assert.rejects(
    fetchToFile(`${srv.base}/none.jpg`, path.join(dir, 'x.jpg'), { fetchImpl: (u, o) => fetch(u, o) }),
    /文件不存在或已被删除/
  );
  await srv.close();
  assert.equal(srv.stats.requests, 1);
});

test('403 给出登录提示而不是通用错误', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => {
    res.writeHead(403);
    res.end();
  });
  await assert.rejects(
    fetchToFile(`${srv.base}/x.jpg`, path.join(dir, 'x.jpg'), { fetchImpl: (u, o) => fetch(u, o) }),
    /没有下载权限/
  );
  await srv.close();
});

test('取消：中断后状态为 canceled 且不会报成失败', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': PAYLOAD.length });
    res.write(PAYLOAD.subarray(0, 1024));
    // 故意不结束，等待客户端中止
  });
  const ctrl = new AbortController();
  const pending = fetchToFile(`${srv.base}/slow.jpg`, path.join(dir, 'slow.jpg'), {
    fetchImpl: (u, o) => fetch(u, o),
    signal: ctrl.signal,
  });
  setTimeout(() => ctrl.abort(), 250);
  await assert.rejects(pending, /已取消/);
  await srv.close();
});

test('itemDir 目录命名：平台/作者/标题_id，非法字符被清洗', () => {
  const dir = itemDir('D:\\下载', '小红书', {
    id: '66f0a1b2c3d4e5f601234567',
    title: 'a/b:c? 测试',
    author: '兔兔酱',
  });
  assert.ok(dir.startsWith(path.join('D:\\下载', '小红书', '兔兔酱')));
  assert.ok(!/[\\/:*?"<>|]/.test(path.basename(dir).replace(/_/g, '')));
  assert.ok(dir.endsWith('f601234567'));
});

test('批量下载：并发跑完、目录结构正确、图片与视频分别落盘', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => {
    if (req.url.endsWith('.mp4')) return sendFull(res, Buffer.alloc(8 * 1024, 3), 'video/mp4');
    return sendFull(res, Buffer.alloc(4 * 1024, 2), 'image/jpeg');
  });

  const platform = { id: 'xhs', name: '小红书' };
  const items = [
    {
      id: 'aaa111',
      title: '两条图',
      author: '兔兔酱',
      type: 'image',
      assets: [
        { kind: 'image', url: `${srv.base}/1.jpg`, still: '', ext: '' },
        { kind: 'image', url: `${srv.base}/2.jpg`, still: '', ext: '' },
      ],
    },
    {
      id: 'bbb222',
      title: '一条视频',
      author: '兔兔酱',
      type: 'video',
      assets: [{ kind: 'video', url: `${srv.base}/3.mp4`, still: '', ext: 'mp4' }],
    },
  ];

  const events = [];
  const dl = new Downloader({
    rootDir: dir,
    concurrency: 2,
    fetchImpl: (u, o) => fetch(u, o),
    getSession: () => null,
    onEvent: (e) => events.push(e),
  });
  const summary = await dl.run(items.map((item) => ({ item, platform })));
  await srv.close();

  assert.equal(summary.total, 2);
  assert.equal(summary.success, 2);
  assert.equal(summary.failed, 0);

  const dirA = path.join(dir, '小红书', '兔兔酱');
  const albums = fs.readdirSync(dirA);
  assert.equal(albums.length, 2);
  const albumDir = path.join(dirA, albums.find((n) => n.includes('aaa111')));
  const files = fs.readdirSync(albumDir).sort();
  assert.deepEqual(files, ['01_图片.jpg', '02_图片.jpg']);

  const videoDir = path.join(dirA, albums.find((n) => n.includes('bbb222')));
  const vfiles = fs.readdirSync(videoDir);
  assert.equal(vfiles[0], '视频.mp4');

  assert.ok(events.some((e) => e.type === 'item-progress'));
  const done = events.filter((e) => e.type === 'item-done');
  assert.equal(done.length, 2);
  assert.ok(done.every((d) => d.status === 'success'));
});

test('批量下载：单个作品失败不影响其他作品，并记录失败原因', async () => {
  const dir = tmpDir();
  const srv = await serve((req, res) => {
    if (req.url.includes('bad')) {
      res.writeHead(500);
      res.end();
      return;
    }
    sendFull(res, Buffer.alloc(1024, 1));
  });

  const items = [
    { id: 'ok1', title: 'ok', author: 'a', assets: [{ kind: 'image', url: `${srv.base}/ok.jpg` }] },
    { id: 'bad1', title: 'bad', author: 'a', assets: [{ kind: 'image', url: `${srv.base}/bad.jpg` }] },
  ];
  const events = [];
  const dl = new Downloader({
    rootDir: dir,
    concurrency: 2,
    fetchImpl: (u, o) => fetch(u, o),
    getSession: () => null,
    onEvent: (e) => events.push(e),
  });
  const summary = await dl.run(items.map((item) => ({ item, platform: { id: 'weibo', name: '微博' } })));
  await srv.close();

  assert.equal(summary.success, 1);
  assert.equal(summary.failed, 1);
  const failedEvent = events.find((e) => e.type === 'item-done' && e.status === 'failed');
  assert.ok(failedEvent && /HTTP 500/.test(failedEvent.error));
});
