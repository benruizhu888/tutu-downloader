'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ffmpegPath, probe, ensureMp4 } = require('../../src/main/media');

const BIN = ffmpegPath();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tutu-media-'));

test('ffmpeg 随应用分发，路径可执行', (t) => {
  if (!BIN) return t.skip('未安装 @ffmpeg-installer/ffmpeg');
  assert.ok(fs.existsSync(BIN), 'ffmpeg 二进制应存在');
  const out = execFileSync(BIN, ['-hide_banner', '-version'], { encoding: 'utf8' });
  assert.match(out, /ffmpeg version/i);
});

test('probe 能读出声明的分辨率/编码/时长', async (t) => {
  if (!BIN) return t.skip('缺少 ffmpeg');
  const dir = tmp();
  const src = path.join(dir, 'src.mp4');
  execFileSync(BIN, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src,
  ]);
  const info = await probe(src);
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.codec, 'h264');
  assert.ok(Math.abs(info.duration - 1) < 0.2);
});

test('已是 mp4 时原样保留，不做任何转码', async (t) => {
  if (!BIN) return t.skip('缺少 ffmpeg');
  const dir = tmp();
  const src = path.join(dir, 'a.mp4');
  execFileSync(BIN, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src]);
  const before = fs.statSync(src).size;
  const out = await ensureMp4(src);
  assert.equal(out.path, src);
  assert.equal(out.converted, false);
  assert.equal(out.lossless, true);
  assert.match(out.note, /未做任何转码/);
  assert.equal(fs.statSync(src).size, before, '文件字节数不变');
});

test('实况图若为 mov 容器：无损封装为 mp4，分辨率与码流不变', async (t) => {
  if (!BIN) return t.skip('缺少 ffmpeg');
  const dir = tmp();
  const src = path.join(dir, 'live.mov');
  execFileSync(BIN, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30',
    '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', src,
  ]);
  const beforeInfo = await probe(src);
  const beforeSize = fs.statSync(src).size;

  const out = await ensureMp4(src);
  assert.equal(out.converted, true);
  assert.equal(out.lossless, true);
  assert.ok(out.path.endsWith('.mp4'));
  assert.ok(fs.existsSync(out.path));
  assert.ok(!fs.existsSync(src), '原始 mov 应被替换');

  const afterInfo = await probe(out.path);
  assert.equal(afterInfo.width, beforeInfo.width);
  assert.equal(afterInfo.height, beforeInfo.height);
  assert.equal(afterInfo.codec, beforeInfo.codec);
  const afterSize = fs.statSync(out.path).size;
  assert.ok(Math.abs(afterSize - beforeSize) / beforeSize < 0.15, '仅换壳，体积不应大幅变化');
});

test('转封装失败时保留原文件，绝不降质重编码', async (t) => {
  if (!BIN) return t.skip('缺少 ffmpeg');
  const dir = tmp();
  const fake = path.join(dir, 'broken.webm');
  fs.writeFileSync(fake, Buffer.alloc(2048, 9));
  const out = await ensureMp4(fake);
  assert.equal(out.path, fake);
  assert.equal(out.converted, false);
  assert.ok(fs.existsSync(fake), '原始文件必须还在');
  assert.match(out.note, /保留原始视频文件/);
});
