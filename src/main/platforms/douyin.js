'use strict';

const U = require('./util');

const HOST = 'https://www.douyin.com';

/** 去水印：playwm → play */
function deWatermark(url) {
  return String(url || '').replace('/playwm/', '/play/').replace('&watermark=1', '');
}

/** 选码率最高（同分辨率优先 H.264）的视频地址 */
function pickBestVideo(video) {
  if (!video || typeof video !== 'object') return { url: '', hevc: false };
  const cands = [];
  const add = (addr, w, h, br, hevc) => {
    if (!addr) return;
    const list = U.toUrlList(addr);
    const url = list.find((u) => /^https?:\/\//.test(u));
    if (!url) return;
    cands.push({ url: deWatermark(U.absUrl(url)), w, h, br, hevc: !!hevc });
  };
  if (Array.isArray(video.bit_rate)) {
    for (const b of video.bit_rate) {
      const pa = b.play_addr || b.playAddr || {};
      add(pa, pa.width || b.width, pa.height || b.height, b.bit_rate || b.bitRate, b.is_bytevc1 === 1 || b.is_h265 === true);
    }
  }
  add(video.play_addr_h264 || video.playAddrH264, 0, 0, 0, false);
  add(video.play_addr || video.playAddr, video.width, video.height, 0, false);
  add(video.download_addr || video.downloadAddr, 0, 0, 0, false);
  if (!cands.length) return { url: '', hevc: false };
  cands.sort((a, b) => (b.w * b.h) - (a.w * a.h) || b.br - a.br || (a.hevc === b.hevc ? 0 : a.hevc ? 1 : -1));
  return { url: cands[0].url, hevc: cands[0].hevc };
}

/** 带水印 / 播放器专用变体的特征 */
const WATER_MARK = /(~tplv-dy-water|water-v2|watermark|playwm)/i;

/**
 * 图集里的一张静图。
 *
 * 注意：抖音的图片地址形如
 *   https://p3-sign.douyinpic.com/tos-cn-i-xxxx/abc123~tplv-dy-aweme-images:q75.webp?x-signature=…
 * `~tplv-…` 是 CDN 的图片模板后缀，**签名是对含后缀的完整 path 算的**。
 * 以前为了「拿原图」把后缀砍掉，结果整条图集全部 403（实测 200 → 403，238 字节的报错页），
 * 这就是「抖音图集下不了」的根因。所以这里只在**平台给的变体之间**挑选，绝不改路径。
 *
 * 挑选顺序：无水印 > jpeg（比 webp 大一档，画质更好）> 尺寸更大的。
 */
function imageStill(img) {
  if (!img) return '';
  const cands = [];
  const push = (v) => {
    for (const u of U.toUrlList(v)) {
      const clean = U.absUrl(u);
      if (clean && !cands.includes(clean)) cands.push(clean);
    }
  };
  push(img.display_image || img.displayImage);
  push(img.url_list || img.urlList);
  push(img.owner_watermark_image);
  push(img.download_url_list || img.downloadUrlList);
  push(img.thumbnail);
  if (!cands.length) return '';

  const score = (u) => {
    let s = 0;
    if (WATER_MARK.test(u)) s -= 100; // 有水印的排到最后，实在没别的才用
    if (/\.jpe?g(\?|$|~)/i.test(u)) s += 30;
    else if (/\.webp(\?|$|~)/i.test(u)) s += 10;
    if (/~tplv-dy-aweme-images/i.test(u)) s += 5;
    const m = /(\d{3,4})x(\d{3,4})/.exec(u);
    if (m) s += Math.min(20, (Number(m[1]) * Number(m[2])) / 2e5);
    return s;
  };
  cands.sort((a, b) => score(b) - score(a));
  return cands[0];
}

function imageMotion(img) {
  const v = img && (img.video || img.video_info || img.live_photo);
  if (!v) return '';
  return pickBestVideo(v).url;
}

function normalizeAweme(a, ctx = {}) {
  if (!a) return null;
  const id = String(a.aweme_id || a.awemeId || a.id || '');
  if (!id) return null;

  const images = (a.image_post_info && a.image_post_info.images) || a.images || [];
  const isAlbum = Array.isArray(images) && images.length > 0;
  const author = (a.author && (a.author.nickname || a.author.unique_id)) || ctx.author || '';
  const assets = [];
  const seen = new Set();
  const add = (x) => {
    if (!x || !x.url || seen.has(x.url)) return;
    seen.add(x.url);
    assets.push(x);
  };

  if (Array.isArray(images) && images.length) {
    for (const img of images) {
      const still = imageStill(img);
      const motion = imageMotion(img);
      if (motion) add({ kind: 'live', url: motion, still, ext: 'mp4' });
      else if (still) add({ kind: 'image', url: still, still, ext: U.extFromUrl(still) || '' });
    }
  } else {
    const best = pickBestVideo(a.video);
    if (best.url) add({ kind: 'video', url: best.url, still: imageStill({ display_image: a.video && a.video.cover, url_list: a.video && a.video.origin_cover && a.video.origin_cover.url_list }), ext: 'mp4' });
  }

  const cover =
    (a.video && (U.toUrlList(a.video.cover)[0] || U.toUrlList(a.video.origin_cover && a.video.origin_cover.url_list)[0])) ||
    (assets[0] && assets[0].still) ||
    '';

  return U.makeItem({
    id,
    platform: 'douyin',
    title: (a.desc || '').trim() || `作品 ${id}`,
    desc: a.desc || '',
    author,
    // 分享短链是移动版域名（iesdouyin），内嵌桌面浏览器里会跳来跳去，统一用桌面详情页。
    // 图集是 /note/<id>，视频才是 /video/<id>，走错了页面打开的是空白播放器。
    pageUrl: `${HOST}/${isAlbum ? 'note' : 'video'}/${id}`,
    cover: U.originalImageUrl(cover),
    createdAt: (Number(a.create_time) || 0) * 1000,
    assets,
  });
}

module.exports = {
  id: 'douyin',
  name: '抖音',
  accent: '#161823',
  homeUrl: HOST,

  matchUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/v\.douyin\.com\//i.test(raw)) return { shortUrl: U.absUrl(raw.startsWith('http') ? raw : 'https://' + raw) };
    const m = /douyin\.com\/user\/([0-9A-Za-z_\-]+)/i.exec(raw);
    if (m) return { userId: m[1], profileUrl: U.absUrl(raw.startsWith('http') ? raw : 'https://' + raw) };
    return null;
  },

  listMatchers: [/\/aweme\/v1\/web\/aweme\/post\//i, /\/aweme\/v1\/web\/aweme\/post\?/i],
  detailMatchers: [/\/aweme\/v1\/web\/aweme\/detail\//i],

  parseList(json, ctx) {
    const list = (json && (json.aweme_list || (json.data && json.data.aweme_list))) || [];
    const items = list.map((a) => normalizeAweme(a, ctx)).filter(Boolean);
    const hasMore = json ? json.has_more === 1 || json.has_more === true : false;
    return { items, hasMore, author: (items[0] && items[0].author) || ctx.author || '' };
  },

  parseDetail(json) {
    const a = (json && (json.aweme_detail || (json.data && json.data.aweme_detail))) || null;
    const it = normalizeAweme(a, {});
    return it ? [it] : [];
  },

  detailUrl(item) {
    // 图集必须开 /note/，视频开 /video/；沿用作品自己的地址最准
    const p = String((item && item.pageUrl) || '');
    if (/douyin\.com\/(note|video)\/\d+/.test(p)) return p;
    const kind = item && (item.type === 'video' ? 'video' : 'note');
    return `${HOST}/${kind}/${(item && item.id) || ''}`;
  },

  needsDetail(item) {
    return !item.assets || item.assets.length === 0;
  },

  /** 作品的标准打开地址 */
  pageUrlFor(id) {
    return `${HOST}/video/${String(id || '')}`;
  },

  referer: HOST + '/',
  normalizeAweme,
};
