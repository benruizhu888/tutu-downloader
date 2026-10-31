'use strict';

/**
 * 平台解析公共工具。
 * 三个平台的数据结构经常变动，因此这里既提供显式取值，也提供「深度扫描」兜底。
 */

function absUrl(u, base) {
  if (!u || typeof u !== 'string') return '';
  let s = u.trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('http://')) return 'https://' + s.slice(7);
  if (s.startsWith('https://')) return s;
  if (s.startsWith('/')) {
    try { return new URL(s, base || 'https://example.com').toString(); } catch { return ''; }
  }
  return '';
}

/** 把各种「一个 URL / URL 数组 / {url_list:[]} / {url:}」统一成字符串数组 */
function toUrlList(v) {
  const out = [];
  if (!v) return out;
  if (typeof v === 'string') { out.push(v); return out; }
  if (Array.isArray(v)) {
    for (const it of v) out.push(...toUrlList(it));
    return out;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.url_list)) out.push(...toUrlList(v.url_list));
    if (typeof v.url === 'string') out.push(v.url);
    if (typeof v.master_url === 'string') out.push(v.master_url);
    if (typeof v.masterUrl === 'string') out.push(v.masterUrl);
    if (typeof v.src === 'string') out.push(v.src);
    if (typeof v.uri === 'string' && /^https?:/.test(v.uri)) out.push(v.uri);
  }
  return out;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|flv|ts|mkv)(\?|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp)(\?|$)/i;

function looksLikeVideo(url) {
  if (!url) return false;
  const u = String(url);
  if (VIDEO_EXT.test(u)) return true;
  // 很多 CDN 用无扩展名的路径，用特征词判断
  return /(^|[/.])(video|stream|play|mvod|livephoto)([/.]|$)/i.test(u) && !IMAGE_EXT.test(u);
}

function looksLikeImage(url) {
  if (!url) return false;
  const u = String(url);
  if (VIDEO_EXT.test(u)) return false;
  if (IMAGE_EXT.test(u)) return true;
  return /(^|[/.])(image|img|pic|photo|cover|sns-img|thumb)([/.]|$)/i.test(u);
}

/** 站点自身资源/头像/图标这类「不是作品内容」的图片 */
const JUNK_IMAGE = /(picasso-static|fe-platform|fe-static|sns-avatar|\/avatar\/|\/emoji\/|\/icon\/|\/logo\/|favicon|sprite)/i;
/** 平台真实的图片/视频 CDN（含小红书 ci 原图域） */
const CONTENT_HOST = /(^|\.)(xhscdn\.com|xiaohongshu\.com|sinaimg\.cn|weibocdn\.com|douyinpic\.com|douyincdn\.com|douyinstatic\.com)$/i;

/**
 * 是不是「作品内容图」。
 * 小红书原图地址常常没有扩展名（sns-webpic-qc.xhscdn.com/.../notes_pre_post/xxx），
 * 所以先按 CDN 域名认，再退回按扩展名/路径特征判断。
 */
function isContentImage(url) {
  const u = String(url || '');
  if (!u) return false;
  if (JUNK_IMAGE.test(u)) return false;
  let host = '';
  try { host = new URL(u).hostname; } catch { return false; }
  if (CONTENT_HOST.test(host)) return true;
  return looksLikeImage(u);
}

/** 迭代遍历 JSON，回调 (key, value, depth)；保持对象/数组的原始顺序 */
function walkJson(root, visit, maxDepth = 14) {
  let guard = 0;
  const walk = (node, key, depth) => {
    if (node === null || node === undefined) return;
    if (depth > maxDepth) return;
    if (++guard > 200000) return;
    if (typeof node === 'object') {
      visit(key, node, depth);
      if (Array.isArray(node)) {
        for (const item of node) walk(item, key, depth + 1);
      } else {
        for (const k of Object.keys(node)) walk(node[k], k, depth + 1);
      }
    } else if (typeof node === 'string') {
      visit(key, node, depth);
    }
  };
  walk(root, '', 0);
}

/**
 * 从任意对象里尽量捞出媒体地址（兜底用）。
 * 返回 { images: [], videos: [] }，已去重且保持出现顺序。
 */
function harvestMedia(obj, opts = {}) {
  const images = [];
  const videos = [];
  const seen = new Set();
  const push = (list, url) => {
    const u = absUrl(url, opts.base);
    if (!u || seen.has(u)) return;
    seen.add(u);
    list.push(u);
  };
  walkJson(obj, (key, value) => {
    if (typeof value === 'string') {
      if (/^https?:\/\//.test(value) || value.startsWith('//')) {
        if (looksLikeVideo(value)) push(videos, value);
        else if (looksLikeImage(value)) push(images, value);
      }
      return;
    }
    if (key && /(stream|play|video|master|mp4|h264|h265|avc|hevc)/i.test(key)) {
      for (const u of toUrlList(value)) if (looksLikeVideo(u)) push(videos, u);
    }
    if (key && /(image|img|pic|photo|cover|thumb)/i.test(key)) {
      for (const u of toUrlList(value)) if (looksLikeImage(u)) push(images, u);
    }
  });
  return { images, videos };
}

/** 依据 URL 猜扩展名 */
function extFromUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(url || ''));
  if (!m) return '';
  const e = m[1].toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'mp4', 'mov', 'm4v', 'webm'].includes(e)) {
    return e === 'jpeg' ? 'jpg' : e;
  }
  return '';
}

/** 依据响应 Content-Type 猜扩展名 */
function extFromContentType(ct) {
  const s = String(ct || '').toLowerCase();
  if (s.includes('image/jpeg')) return 'jpg';
  if (s.includes('image/png')) return 'png';
  if (s.includes('image/webp')) return 'webp';
  if (s.includes('image/heic') || s.includes('image/heif')) return 'heic';
  if (s.includes('image/gif')) return 'gif';
  if (s.includes('video/mp4')) return 'mp4';
  if (s.includes('video/quicktime')) return 'mov';
  if (s.includes('video/webm')) return 'webm';
  return '';
}

/**
 * 取原图地址：尽量绕开平台的「缩略图/压缩图」变体。
 * - 小红书 xhscdn：`sns-webpic-qc.xhscdn.com/<ts>/<md5>/<scene>/<key>!nd_dft_wlteh_webp_3`
 *   是压过的 webp（1080 宽），原图要用 `ci.xiaohongshu.com/<scene>/<key>`
 * - 微博 sinaimg：/mw690/ /thumb150/ 等换成 /large/
 * - 抖音 douyinpic：**原样返回**。CDN 的 x-signature 是按「含 ~tplv-xxx 模板后缀的 path」
 *   算出来的，砍掉后缀签名立刻失效（实测 200 → 403）。要更高的画质只能在不同变体里挑，
 *   不能改路径。
 */
function originalImageUrl(url) {
  const u = absUrl(url);
  if (!u) return '';
  try {
    const parsed = new URL(u);
    const host = parsed.hostname;

    // 头像不是作品内容，别乱改
    if (/^sns-avatar/i.test(host)) return u;

    if (/(^|\.)xhscdn\.com$/i.test(host)) {
      const segs = parsed.pathname.split('/').filter(Boolean);
      const last = (segs[segs.length - 1] || '').split('!')[0];
      if (/^[0-9a-zA-Z_-]{20,}$/.test(last)) {
        const prev = segs[segs.length - 2] || '';
        const idLike = /^[0-9a-f]{32}$/i.test(prev) || /^\d{6,}$/.test(prev);
        const scene = prev && !idLike ? prev : '';
        return `https://ci.xiaohongshu.com/${scene ? scene + '/' : ''}${last}`;
      }
      // 老式 sns-img 链接（.jpg 结尾 + imageView2 之类参数）继续走下面的通用清理；
      // 但新的 sns-webpic 变体地址不能砍掉 !nd_ 后缀，砍了会 403，所以原样返回。
      if (!/imageView|imageMogr2|resize|x-oss-process/i.test(parsed.search)) return u;
    }

    if (/(^|\.)sinaimg\.cn$/i.test(host)) {
      parsed.pathname = parsed.pathname.replace(/\/(thumb\d+|mw\d+|orj\d+|bmiddle|small|square)\//i, '/large/');
      return parsed.toString();
    }
    if (/(^|\.)(douyinpic|douyinstatic|douyincdn)\.com$/i.test(host) || /douyinpic/i.test(host)) {
      // 见上方注释：~tplv-xxx 后缀参与签名，删了就 403，必须原样返回
      return u;
    }
    // 通用：去掉缩放类查询参数与 webp 变体后缀
    if (/imageView2|imageMogr2|imageView|resize|x-oss-process/i.test(parsed.search)) {
      parsed.search = '';
    }
    parsed.pathname = parsed.pathname.replace(/![^/]*$/, '');
    return parsed.toString();
  } catch {
    return u;
  }
}

/** 展示用地址：原样保留平台给的缩略变体，列表里加载更快 */
function displayImageUrl(url) {
  return absUrl(url);
}

const ILLEGAL = /[\\/:*?"<>|\r\n\t]/g;

/** 文件名清洗：Windows 保留字、超长、首尾点空格 */
function sanitizeName(name, fallback = '未命名', maxLen = 60) {
  let s = String(name == null ? '' : name)
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!s) s = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || fallback;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * 统一的作品对象：
 * { id, platform, type, title, desc, author, pageUrl, cover, createdAt,
 *   assets: [{ kind:'image'|'video'|'live', url, still, ext }] }
 * type 由 assets 推断：含 live → live；含 video → video；否则 image
 */
function makeItem(data) {
  const assets = (data.assets || []).filter((a) => a && a.url);
  let type = data.type;
  if (!type) {
    if (assets.some((a) => a.kind === 'live')) type = 'live';
    else if (assets.some((a) => a.kind === 'video')) type = 'video';
    else type = 'image';
  }
  return {
    id: String(data.id || ''),
    platform: data.platform || '',
    type,
    title: data.title || '',
    desc: data.desc || '',
    author: data.author || '',
    pageUrl: data.pageUrl || '',
    cover: data.cover || (assets[0] && (assets[0].still || assets[0].url)) || '',
    createdAt: Number(data.createdAt) || 0,
    assets,
  };
}

/**
 * 关掉「实况图导出为 MP4」时，把 live 资产降级成静图。
 *
 * 实况图资产的 url 是动态那半段视频，still 才是配对的原图。
 * 三个平台的 live 资产都保证带 still（xhs: imageList[i].urlDefault、
 * weibo: pic_infos[].large.url、douyin: images[i].url_list），
 * 所以降级只需要换 url，不需要再发一次请求。
 */
function downgradeLiveAssets(assets) {
  const out = [];
  for (const a of assets || []) {
    if (!a) continue;
    if (a.kind !== 'live') {
      out.push(a);
      continue;
    }
    // 没有配对静图就没法降级（只留空）
    if (a.still) {
      out.push({ kind: 'image', url: a.still, still: a.still, ext: extFromUrl(a.still) || '' });
    }
  }
  return out;
}

module.exports = {
  absUrl,
  toUrlList,
  looksLikeVideo,
  looksLikeImage,
  isContentImage,
  walkJson,
  harvestMedia,
  originalImageUrl,
  displayImageUrl,
  extFromUrl,
  extFromContentType,
  sanitizeName,
  uniqBy,
  makeItem,
  downgradeLiveAssets,
};
