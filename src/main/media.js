'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let FFMPEG = null;
try {
  // 随应用分发的静态 ffmpeg，避免要求用户自行安装
  // eslint-disable-next-line global-require
  FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
} catch {
  FFMPEG = null;
}

/** 打包后二进制被解到 app.asar.unpacked，要换回真实路径才能执行 */
function unpackedPath(p) {
  if (!p) return p;
  return p.includes('app.asar') ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : p;
}

function ffmpegPath() {
  const p = unpackedPath(FFMPEG);
  if (p && fs.existsSync(p)) return p;
  return null;
}

function run(bin, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const VIDEO_CODECS = /Video:\s*([a-z0-9_]+)/i;

/** 用 ffmpeg -i 读取媒体信息（不依赖 ffprobe） */
async function probe(file) {
  const bin = ffmpegPath();
  if (!bin) return null;
  const { stderr } = await run(bin, ['-hide_banner', '-i', file], 20000);
  const info = { codec: '', width: 0, height: 0, duration: 0, hasAudio: /Audio:\s*/.test(stderr), bitrate: 0 };
  const v = /Stream #\d+:\d+.*?: Video:\s*([a-zA-Z0-9_]+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
  if (v) {
    info.codec = v[1].toLowerCase();
    info.width = Number(v[2]);
    info.height = Number(v[3]);
  } else {
    const c = VIDEO_CODECS.exec(stderr);
    if (c) info.codec = c[1].toLowerCase();
    const dim = /(\d{2,5})x(\d{2,5})/.exec(stderr);
    if (dim) { info.width = Number(dim[1]); info.height = Number(dim[2]); }
  }
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const br = /bitrate:\s*(\d+)\s*kb\/s/i.exec(stderr);
  if (br) info.bitrate = Number(br[1]);
  return info;
}

function sameStream(a, b) {
  if (!a || !b) return false;
  const dimOk = a.width === b.width && a.height === b.height;
  const durOk = !a.duration || !b.duration || Math.abs(a.duration - b.duration) < 0.25;
  return dimOk && durOk && a.codec === b.codec;
}

/**
 * 确保文件是 .mp4，且**不重新编码**。
 * - 源本身就是 mp4：原样保留（真正的原画，零损耗）
 * - 源是 mov/webm 等容器：`-c copy` 仅换壳，码流与分辨率不变
 * - 没有 ffmpeg：保留原始文件，不做任何牺牲画质的转码
 *
 * @returns {{path:string, converted:boolean, lossless:boolean, info:object|null, note:string}}
 */
async function ensureMp4(file, opts = {}) {
  const ext = path.extname(file).toLowerCase();
  const bin = ffmpegPath();
  const before = await probe(file);

  if (ext === '.mp4') {
    return { path: file, converted: false, lossless: true, info: before, note: '原画直取，未做任何转码' };
  }
  if (!bin) {
    return { path: file, converted: false, lossless: true, info: before, note: '未检测到 ffmpeg，已保留原始视频文件' };
  }

  const target = file.replace(/\.[^.]+$/, '') + '.mp4';
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-c', 'copy', '-movflags', '+faststart'];
  if (before && /hevc|h265/.test(before.codec)) args.push('-tag:v', 'hvc1');
  args.push(target);

  const r = await run(bin, args, opts.timeout || 180000);
  if (r.code !== 0 || !fs.existsSync(target)) {
    return { path: file, converted: false, lossless: true, info: before, note: '封装转换失败，已保留原始视频文件' };
  }
  const after = await probe(target);
  const lossless = sameStream(before, after);
  if (!lossless) {
    // 码流对不上说明这次封装不可靠，宁可交原始文件
    try { fs.unlinkSync(target); } catch {}
    return { path: file, converted: false, lossless: true, info: before, note: '校验未通过，已保留原始视频文件' };
  }
  try { fs.unlinkSync(file); } catch {}
  return {
    path: target,
    converted: true,
    lossless: true,
    info: after,
    note: `无损封装为 MP4（${after.codec || '原编码'} ${after.width}x${after.height}）`,
  };
}

module.exports = { ffmpegPath, probe, ensureMp4, sameStream };
