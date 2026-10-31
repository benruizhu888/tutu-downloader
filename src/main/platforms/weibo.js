'use strict';

const U = require('./util');

const HOST = 'https://weibo.com';

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function picUrl(info) {
  if (!info) return '';
  const cand = info.largest || info.large || info.original || info.bmiddle;
  const raw = (cand && cand.url) || U.toUrlList(cand)[0] || info.url || '';
  return U.originalImageUrl(raw);
}

/**
 * 实况图（Live Photo）的播放地址是不是可用。
 *
 * 详情接口里长这样（实测）：
 *   pic_infos[<pid>].type      = "livephoto"
 *   pic_infos[<pid>].fid       = "003W6UA6jx08B6fxBorB0h04110021fN0k01"
 *   pic_infos[<pid>].video     = "https://video.weibo.com/media/play?livephoto=https%3A%2F%2Fus.sinaimg.cn%2F003W...k01.mov&Expires=…&ssig=…&KID=unistore,video"
 *   pic_infos[<pid>].video_hd  = "https://video.weibo.com/media/play?livephoto=https%3A%2F%2Fus.sinaimg.cn%2F.mov"   ← 被截断，坏的
 *
 * 注意：`https://us.sinaimg.cn/<fid>.mov` 直连会 403（要签名），
 * 只有 video.weibo.com/media/play 这个中转地址能下（实测 200 video/mp4）。
 */
function livePlayUrl(url) {
  const u = String(url || '');
  const m = /[?&]livephoto=([^&]+)/i.exec(u);
  if (!m) return false;
  let inner = '';
  try { inner = decodeURIComponent(m[1]); } catch { inner = m[1]; }
  // 必须有真实文件名：video_hd 那种 "...sinaimg.cn/.mov" 一定是坏的
  return /\/[^/]{6,}\.(mov|mp4)(\?|$)/i.test(inner);
}

/** 从实况图节点里取可下载的视频地址 */
function livePhotoVideo(info) {
  if (!info || typeof info !== 'object') return '';
  const cands = [];
  const add = (v) => {
    for (const u of U.toUrlList(v)) if (/^https?:\/\//.test(u) && !cands.includes(u)) cands.push(u);
  };
  add(info.video);
  add(info.video_hd);
  add(info.videoHd);
  const lp = info.live_photo || info.livePhoto;
  if (lp && typeof lp === 'object') {
    add(lp.video);
    add(lp.video_hd);
    add(lp.video_url);
    add(lp.mp4_url);
    add(lp.stream_url_hd);
    add(lp.stream_url);
  }
  if (!cands.length) return '';
  // 直连 mp4/mov 的最好；否则用 media/play 中转地址（已验证能下）
  const direct = cands.find((u) => /\.(mp4|mov)(\?|$)/i.test(u) && !/media\/play/i.test(u));
  if (direct) return direct;
  const play = cands.find(livePlayUrl);
  return play || '';
}

function mediaVideoUrl(info) {
  if (!info || typeof info !== 'object') return '';
  const fields = [
    info.stream_url_hd, info.streamUrlHd,
    info.stream_url, info.streamUrl,
    info.mp4_720p_mp4, info.mp4_hd_url, info.mp4_sd_url,
    info.media_info && safe(info.media_info, 'stream_url_hd'),
    info.media_info && safe(info.media_info, 'stream_url'),
  ];
  for (const f of fields) {
    const u = U.toUrlList(f).find((x) => U.looksLikeVideo(x) || /\.mp4/i.test(x));
    if (u) return U.absUrl(u);
  }
  // 实况图：视频放在 video / video_hd 里，以前的字段表完全没覆盖到
  return livePhotoVideo(info);
}

function safe(o, k) {
  return o && o[k];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeStatus(s, ctx = {}) {
  if (!s) return null;
  const id = String(s.idstr || s.id || s.mblogid || '');
  if (!id) return null;

  const text = stripHtml(s.text_raw || s.text || '');
  const author = (s.user && (s.user.screen_name || s.user.name)) || ctx.author || '';
  const assets = [];
  const seen = new Set();
  const add = (x) => {
    if (!x || !x.url || seen.has(x.url)) return;
    seen.add(x.url);
    assets.push(x);
  };

  // 1) 混合媒体（新版）：mix_media_info.items
  const mix = (s.mix_media_info && s.mix_media_info.items) || [];
  for (const it of mix) {
    const d = (it && (it.data || it)) || {};
    // 有的版本把图片信息再包一层 pic_info
    const pic = d.pic_info || d;
    const videoUrl = mediaVideoUrl(pic) || mediaVideoUrl(d) || mediaVideoUrl(it);
    const still = picUrl(pic) || picUrl(d) || picUrl(it);
    if (videoUrl) {
      // 视频：单独一条；图片+视频并存说明是实况图
      add({ kind: still ? 'live' : 'video', url: videoUrl, still, ext: 'mp4' });
    } else if (still) {
      add({ kind: 'image', url: still, still, ext: '' });
    }
  }

  // 2) 普通九宫格
  if (!assets.length) {
    const infos = s.pic_infos && typeof s.pic_infos === 'object' ? Object.values(s.pic_infos) : [];
    for (const info of infos) {
      const still = picUrl(info);
      // 实况图在详情接口里就是一张普通图 + video / video_hd（type="livephoto"），
      // 列表接口只留一个 annotations.from_for_live_photo 标记，拿不到视频。
      const motion = mediaVideoUrl(info) || '';
      if (motion) add({ kind: 'live', url: motion, still, ext: 'mp4' });
      else if (still) add({ kind: 'image', url: still, still, ext: '' });
    }
  }

  // 3) 单条视频（page_info）
  if (!assets.length && s.page_info) {
    const pi = s.page_info;
    const videoUrl = mediaVideoUrl(pi.media_info) || mediaVideoUrl(pi) || '';
    const still = U.originalImageUrl((pi.page_pic && (pi.page_pic.url || U.toUrlList(pi.page_pic)[0])) || '');
    if (videoUrl) add({ kind: 'video', url: videoUrl, still, ext: 'mp4' });
  }

  if (!assets.length) return null; // 纯文字微博不计入

  const retweeted = s.retweeted_status ? normalizeStatus(s.retweeted_status, ctx) : null;
  const cover =
    (retweeted && retweeted.cover) ||
    (assets[0] && (assets[0].still || assets[0].url)) ||
    U.originalImageUrl((s.page_info && s.page_info.page_pic && s.page_info.page_pic.url) || '');

  return U.makeItem({
    id,
    platform: 'weibo',
    title: text ? text.slice(0, 80) : `微博 ${id}`,
    desc: text,
    author,
    pageUrl: `${HOST}/detail/${id}`,
    cover,
    createdAt: s.created_at ? Date.parse(s.created_at) || 0 : Number(s.created_at_timestamp || 0) * 1000,
    assets,
  });
}

module.exports = {
  id: 'weibo',
  name: '微博',
  accent: '#E6162D',
  homeUrl: HOST,

  /**
   * 直连接口取作品列表。
   *
   * 微博的 /ajax/statuses/mymblog 只校验 Cookie，不需要 X-s / a_bogus 之类的签名，
   * 所以在页面上下文里 fetch 就能拿到和网页一模一样的 JSON。
   * 相比「等页面自己发请求再嗅探」，这条路能自己控制翻页、也不会因首屏懒加载而漏数据。
   */
  async fetchList(host, ctx = {}) {
    const src = String(ctx.profileUrl || '');
    const uid =
      (/(?:weibo\.com|weibo\.cn)\/u\/(\d+)/i.exec(src) || [])[1] ||
      (/(?:uid=|weibo\.com\/)(\d{6,})/i.exec(src) || [])[1] ||
      '';
    if (!uid) return { items: [], author: '' };

    const maxPages = Math.max(1, Math.min(24, ctx.maxPages || 12));
    const items = [];
    const mediaSeen = new Set();
    const rawSeen = new Set();
    let author = ctx.author || '';
    let total = 0;
    let staleRounds = 0;

    for (let page = 1; page <= maxPages; page++) {
      if (ctx.shouldStop && ctx.shouldStop()) break;
      const res = await host
        .pageFetchText(`/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`, { timeout: 20000 })
        .catch(() => null);
      if (!res || !res.ok) break;
      let json = null;
      try {
        json = JSON.parse(res.text);
      } catch {
        break;
      }
      const data = (json && json.data) || {};
      const rawList = Array.isArray(data.list) ? data.list : [];
      // total 只有第 1 页给的是账号真实的「全部微博」数量；
      // 翻到第 2 页起接口会改报「还能翻到的条数」，用后面的值会把 95 覆盖成 70。
      if (!total && Number(data.total) > 0) total = Number(data.total);

      const parsed = this.parseList(json, { author });
      if (parsed.author && !author) author = parsed.author;

      let added = 0;
      for (const it of parsed.items) {
        if (mediaSeen.has(it.id)) continue;
        mediaSeen.add(it.id);
        items.push(it);
        added++;
      }
      const rawBefore = rawSeen.size;
      for (const s of rawList) {
        const id = String((s && (s.idstr || s.id || s.mblogid)) || '');
        if (id) rawSeen.add(id);
      }

      if (ctx.onProgress) {
        ctx.onProgress({
          stage: 'scroll',
          message: added ? `已加载 ${items.length} 个作品…` : '正在加载更多…',
          count: items.length,
          page,
        });
      }

      if (!rawList.length) break;
      if (total && rawSeen.size >= total) break;
      if (rawSeen.size === rawBefore && !added) {
        if (++staleRounds >= 2) break;
      } else {
        staleRounds = 0;
      }
      await sleep(300 + Math.floor(Math.random() * 250));
    }

    // total 是平台自己标的「全部微博」数量；raw 是接口真正下发的条数（去重后）。
    // 两者经常不相等：标称数里含仅自己可见 / 已删除 / 不下发的内容，客户端拿不到。
    return { items, author, total, raw: rawSeen.size };
  },

  matchUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/t\.cn\//i.test(raw)) return { shortUrl: U.absUrl(raw.startsWith('http') ? raw : 'https://' + raw) };
    let m = /weibo\.com\/u\/(\d+)/i.exec(raw);
    if (m) return { userId: m[1], profileUrl: `https://weibo.com/u/${m[1]}` };
    m = /m\.weibo\.cn\/(?:u|profile)\/(\d+)/i.exec(raw);
    if (m) return { userId: m[1], profileUrl: `https://weibo.com/u/${m[1]}` };
    m = /weibo\.com\/(\d{6,})(?:[/?#]|$)/i.exec(raw);
    if (m) return { userId: m[1], profileUrl: `https://weibo.com/u/${m[1]}` };
    m = /weibo\.com\/n\/([^/?#]+)/i.exec(raw);
    if (m) return { nickname: decodeURIComponent(m[1]), profileUrl: U.absUrl(raw.startsWith('http') ? raw : 'https://' + raw) };
    if (/weibo\.(com|cn)\//i.test(raw)) return { profileUrl: U.absUrl(raw.startsWith('http') ? raw : 'https://' + raw) };
    return null;
  },

  listMatchers: [
    /\/ajax\/statuses\/mymblog/i,
    /\/ajax\/profile\/statuses/i,
    /\/api\/container\/getIndex/i,
  ],
  detailMatchers: [/\/ajax\/statuses\/show/i, /\/ajax\/statuses\/extend/i],

  parseList(json, ctx) {
    const data = json && (json.data || json);
    const list = (data && (data.list || data.cards || data.statuses)) || [];
    const items = [];
    for (const s of list) {
      const st = s && (s.mblog || s);
      const it = normalizeStatus(st, ctx);
      if (it) items.push(it);
    }
    // 头像昵称：/ajax/profile/info 之类
    const author =
      (data && data.user && (data.user.screen_name || data.user.name)) ||
      (items[0] && items[0].author) ||
      ctx.author ||
      '';
    const hasMore = data ? data.has_more === true || (Array.isArray(data.list) && data.list.length >= 10) : false;
    return { items, hasMore, author };
  },

  parseDetail(json) {
    const data = (json && (json.data || json)) || {};
    const st = data.mblog || data.status || data;
    const it = normalizeStatus(st, {});
    return it ? [it] : [];
  },

  /**
   * 直接在页面上下文里调详情接口。
   *
   * 为什么不再「打开详情页等接口」：微博的实况图视频只出现在 /ajax/statuses/show 里，
   * 而详情页是 SSR + 一堆上报请求，开一次要好几秒还可能被拦；
   * 这个接口只校验 Cookie，页面 fetch 就能拿到和网页一模一样的数据（实测 200，13KB）。
   */
  async fetchDetail(host, item) {
    const id = String((item && item.id) || '');
    if (!id) return [];
    const res = await host.pageFetchText(`/ajax/statuses/show?id=${id}`, { timeout: 20000 }).catch(() => null);
    if (!res || !res.ok) return [];
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      return [];
    }
    return this.parseDetail(json);
  },

  detailUrl(item) {
    return `${HOST}/detail/${item.id}`;
  },

  needsDetail(item) {
    return !item.assets || item.assets.length === 0;
  },

  referer: HOST + '/',
  normalizeStatus,
  stripHtml,
};
