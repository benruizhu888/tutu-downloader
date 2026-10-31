'use strict';

/**
 * 图标构建：把 AI 生成的 1024 图 → 圆角化 → 多尺寸 PNG + Windows .ico
 * 用 Electron 的 Chromium 画布做高质量缩放，避免引入原生图像库。
 *
 * 用法: electron tools/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const RAW = process.argv[2] || path.join(BUILD, 'raw', 'macOS_app_icon__rounded_square_2026-10-29T15-27-37.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const PAGE = `<!DOCTYPE html><html><body><script>
window.build = async function(dataUri) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUri; });
  const S = 1024;
  const base = document.createElement('canvas');
  base.width = base.height = S;
  const bctx = base.getContext('2d');
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(img, 0, 0, S, S);

  // 抹掉右下角生成水印：用邻近渐变铺一块同色块
  const px = (x, y) => { const d = bctx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
  const c1 = px(820, 940); const c2 = px(820, 1010); const c3 = px(960, 900);
  const grad = bctx.createLinearGradient(820, 940, 1024, 1024);
  grad.addColorStop(0, 'rgb(' + c1.join(',') + ')');
  grad.addColorStop(0.6, 'rgb(' + c3.join(',') + ')');
  grad.addColorStop(1, 'rgb(' + c2.join(',') + ')');
  bctx.fillStyle = grad;
  bctx.beginPath();
  bctx.moveTo(838, 918);
  bctx.lineTo(1024, 918);
  bctx.lineTo(1024, 1024);
  bctx.lineTo(918, 1024);
  bctx.closePath();
  bctx.fill();

  // macOS 风格圆角（squircle 近似）
  const out = document.createElement('canvas');
  out.width = out.height = S;
  const ctx = out.getContext('2d');
  const r = Math.round(S * 0.2237);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(S - r, 0);
  ctx.quadraticCurveTo(S, 0, S, r);
  ctx.lineTo(S, S - r);
  ctx.quadraticCurveTo(S, S, S - r, S);
  ctx.lineTo(r, S);
  ctx.quadraticCurveTo(0, S, 0, S - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.save();
  ctx.clip();
  ctx.drawImage(base, 0, 0);
  ctx.restore();

  const result = {};
  const sizes = ${JSON.stringify(SIZES)};
  for (const sz of sizes) {
    if (sz === S) { result[sz] = out.toDataURL('image/png'); continue; }
    const c = document.createElement('canvas');
    c.width = c.height = sz;
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = true;
    cc.imageSmoothingQuality = 'high';
    cc.drawImage(out, 0, 0, sz, sz);
    result[sz] = c.toDataURL('image/png');
  }
  return result;
};
</script></body></html>`;

/** ICO 容器：每个条目内嵌 PNG，Windows Vista 以上原生支持 */
function buildIco(pngList, sizes) {
  const count = pngList.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngList.forEach((buf, i) => {
    const s = sizes[i];
    const b = i * 16;
    entries.writeUInt8(s >= 256 ? 0 : s, b + 0);
    entries.writeUInt8(s >= 256 ? 0 : s, b + 1);
    entries.writeUInt8(0, b + 2);
    entries.writeUInt8(0, b + 3);
    entries.writeUInt16LE(1, b + 4);
    entries.writeUInt16LE(32, b + 6);
    entries.writeUInt32LE(buf.length, b + 8);
    entries.writeUInt32LE(offset, b + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, entries, ...pngList]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  const dataUri = 'data:image/png;base64,' + fs.readFileSync(RAW).toString('base64');
  const result = await win.webContents.executeJavaScript(`window.build(${JSON.stringify(dataUri)})`);

  fs.mkdirSync(path.join(BUILD, 'icons'), { recursive: true });
  const bufs = {};
  for (const [size, uri] of Object.entries(result)) {
    const buf = Buffer.from(String(uri).split(',')[1], 'base64');
    bufs[size] = buf;
    fs.writeFileSync(path.join(BUILD, 'icons', `${size}x${size}.png`), buf);
  }
  fs.writeFileSync(path.join(BUILD, 'icon.png'), bufs['1024']);
  fs.writeFileSync(path.join(BUILD, 'icon-512.png'), bufs['512']);

  const icoPngs = ICO_SIZES.map((s) => bufs[String(s)]);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(icoPngs, ICO_SIZES));

  console.log('ICON_OK', JSON.stringify({ sizes: Object.keys(result).length, ico: ICO_SIZES }));
  app.quit();
}).catch((e) => {
  console.error('ICON_FAIL', e);
  app.exit(1);
});
