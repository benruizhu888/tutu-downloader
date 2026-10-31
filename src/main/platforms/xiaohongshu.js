'use strict';

const U = require('./util');
const { extractEmbeddedState } = require('../sniffer');

const HOST = 'https://www.xiaohongshu.com';

/**
 * 从笔记页的 SSR HTML 里取出作品节点。
 *
 * 小红书笔记页把完整作品数据放在 <script>window.__INITIAL_STATE__=…</script> 里，
 * 结构是 note.noteDetailMap[noteId].note —— 里面有 imageList（每张图的静图与
 * Live 实况的视频流）、title、desc、user.nickname、time。
 */
function noteFromStateHtml(html, id) {
  let fallback = null;
  for (const st of extractEmbeddedState(html || '')) {
    const map = st && st.note && (st.note.noteDetailMap || st.note.detailMap);
    if (!map) continue;
    for (const key of Object.keys(map)) {
      if (!key) continue;
      const entry = map[key];
      const note = entry && (entry.note || entry);
      if (!note) continue;
      const nid = note.noteId || note.note_id || note.id || key;
      if (id && String(nid) !== String(id)) continue;
      if (id) return note;
      if (!fallback) fallback = note;
    }
  }
  return fallback;
}

/**
 * 从一堆视频流里挑分辨率最高的原始流。
 *
 * 小红书的视频对象有三种写法，必须都认：
 *   1) 详情页 __INITIAL_STATE__：imageList[i].stream = { h264:[{ masterUrl }], h265:[], av1:[] }
 *      —— 没有 media 这一层，字段是驼峰 masterUrl/backupUrls
 *   2) 笔记接口：imageList[i].video = { media: { stream: { h264:[{ master_url }] } } }
 *   3) 老结构：video.url / video.consumer.origin_video_key
 * 以前只认第 2 种，第 1 种（实况图实际使用的结构）直接返回空串，
 * 实况图因此被当成普通静图下载 —— 这是「小红书实况没转成视频」的根因之一。
 *
 * 【关键坑】访问过作者主页之后，平台会把 stream 里的编码键名混淆掉：
 *   正常态  stream = { h265:[], h266:[], av1:[], h264:[{ masterUrl }] }
 *   混淆态  stream = { EF6:[], EF5:[], EF7:[], EF4:[{ masterUrl }] }   ← 实况视频就在 EF4 里
 * 实测：不先打开主页直接抓笔记页 → 键名正常；解析流程先开了主页 → 键名被混淆。
 * 因为键名每次都不一样，写死 h264/h265/av1 必然漏掉一半的实况图，
 * 所以这里不认死键名，而是把容器里**所有数组值**都当成候选流，
 * 再按分辨率/码率挑最好的那个。
 */
function pickBestStream(video) {
  if (!video || typeof video !== 'object') return '';
  const streams = [];
  const push = (arr, codec) => {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || typeof s !== 'object') continue;
      const url =
        s.master_url || s.masterUrl || s.backup_url || s.backupUrl ||
        (Array.isArray(s.backup_urls) ? s.backup_urls[0] : '') ||
        (Array.isArray(s.backupUrls) ? s.backupUrls[0] : '');
      if (!url) continue;
      streams.push({
        url: U.absUrl(url),
        w: Number(s.width) || 0,
        h: Number(s.height) || 0,
        br: Number(s.avg_bitrate || s.avgBitrate || s.bitrate) || 0,
        codec,
      });
    }
  };

  // 收集所有可能的「stream 容器」，去重后逐个取流
  const pools = [];
  if (video.stream && typeof video.stream === 'object') pools.push(video.stream);
  if (video.media && video.media.stream) pools.push(video.media.stream);
  // 传进来的可能本身就是容器（imageList[i].stream 直接就是 {h264:[…]} 这种），
  // 混淆态下它的键名是 EF4/EF5…，所以不能靠 h264/h265/av1 判断「自己是不是容器」，
  // 一律把自身也当容器扫一遍。
  pools.push(video);

  const seenPool = new Set();
  for (const p of pools) {
    if (seenPool.has(p)) continue;
    seenPool.add(p);
    // 认得的编码键优先（可以据此判断 h264 兼容性）
    push(p.h264, 'h264');
    push(p.h265, 'h265');
    push(p.av1, 'av1');
    // 平台混淆后的键名（EF4/EF5/EF6/EF7…）每次都不一样：
    // 不认死名字，把容器里其余的数组值也一并当候选流收进来。
    for (const key of Object.keys(p)) {
      if (key === 'h264' || key === 'h265' || key === 'av1' || key === 'h266') continue;
      const val = p[key];
      if (Array.isArray(val)) push(val, key);
    }
  }

  // 老结构：video.url / video.consumer.origin_video_key
  if (!streams.length) {
    const direct = U.toUrlList(video.url || video.origin_video_key || (video.consumer && video.consumer.origin_video_key));
    for (const u of direct) if (U.looksLikeVideo(u)) streams.push({ url: U.absUrl(u), w: 0, h: 0, br: 0, codec: '' });
  }
  if (!streams.length) return '';
  // 同分辨率时代码兼容性优先：h264 > h265 > av1 > 其它（EF 键名无法判断编码时排最后）
  const codecRank = { h264: 0, h265: 1, av1: 2 };
  streams.sort(
    (a, b) =>
      (b.w * b.h) - (a.w * a.h) ||
      b.br - a.br ||
      (codecRank[a.codec] ?? 3) - (codecRank[b.codec] ?? 3)
  );
  return streams[0].url;
}

/** image_list 单项 → 平台 CDN 上的原始地址（可能带 webp 变体后缀） */
function pickImageRaw(img) {
  if (!img) return '';
  // 详情页 state 里是驼峰（infoList/imageScene），接口里是下划线（info_list/image_scene），两种都要认
  const infos = img.info_list || img.infoList;
  if (Array.isArray(infos) && infos.length) {
    const scenes = infos.slice();
    const sceneOf = (s) => String(s.image_scene || s.imageScene || '');
    const dft = scenes.find((s) => /WB_DFT|CRD_WM|default/i.test(sceneOf(s))) || scenes[0];
    const byScene = (name) => scenes.find((s) => sceneOf(s).toUpperCase() === name);
    const best = byScene('WB_DFT') || dft;
    if (best && best.url) return best.url;
  }
  return img.url_default || img.urlDefault || img.url_pre || img.urlPre || img.url || img.src || '';
}

/** 原图地址（ci.xiaohongshu.com，未压缩）；取不到原图时返回 CDN 变体 */
function pickImageUrl(img) {
  return U.originalImageUrl(pickImageRaw(img));
}

function noteUrl(id, token) {
  const base = `${HOST}/explore/${id}`;
  if (!token) return base;
  return `${base}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user`;
}

/**
 * 从笔记页 HTML 里扫媒体地址。
 * 视频笔记的播放地址只写在脚本数据里（masterUrl），页面上没有可读的 <video src>，
 * 所以详情解析的最后一级用这条兜底。
 */
function mediaFromHtml(html) {
  const src = String(html || '');
  if (!src) return { images: [], videos: [] };
  // JSON 里的斜杠可能是 \/ 或 \u002F，HTML 里还会有 &amp;，先还原成正常 URL
  const flat = src.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');

  const videos = [];
  const seenV = new Set();
  const pushV = (u) => {
    const clean = U.absUrl(String(u || '').replace(/[\\"'\s<>].*$/, ''));
    if (!clean || !/xhscdn\.com\//i.test(clean)) return;
    if (!/(\/stream\/|\/video\/|\.mp4)/i.test(clean)) return;
    // 同一个视频会有 qc/hw/bd/qn 多个 CDN 与多档清晰度，按 stream id 去重
    const key = clean.replace(/^https?:\/\/[^/]+/, '').replace(/_\d+\.mp4.*$/, '');
    if (seenV.has(key)) return;
    seenV.add(key);
    videos.push(clean);
  };
  const reV = /https?:\/\/sns-video[\w.-]*xhscdn\.com\/[^"'\s\\<>]+/gi;
  let m;
  let guard = 0;
  while ((m = reV.exec(flat)) && guard++ < 40) pushV(m[0]);

  // 优先不带 _258 / _520 这类清晰度后缀的主播放地址
  videos.sort((a, b) => {
    const sa = /_\d{3,4}\.mp4/i.test(a) ? 0 : 1;
    const sb = /_\d{3,4}\.mp4/i.test(b) ? 0 : 1;
    return sb - sa;
  });

  const images = [];
  const seenI = new Set();
  const reI = /https?:\/\/sns-(?:webpic|img)[\w.-]*xhscdn\.com\/[^"'\s\\<>]+/gi;
  guard = 0;
  while ((m = reI.exec(flat)) && guard++ < 400) {
    const u = U.originalImageUrl(m[0]);
    if (!u || seenI.has(u)) continue;
    seenI.add(u);
    images.push(u);
  }
  // 实况图一篇可能有多张（实测一条笔记 3 张），以前只留 1 个视频，另外两张就丢了
  return { images, videos: videos.slice(0, 9) };
}

/** 把一条 note（列表或详情结构）转成统一作品对象 */
function normalizeNote(raw, ctx = {}) {
  if (!raw) return null;
  const card = raw.note_card || raw.noteCard || raw;
  const id = String(card.note_id || card.noteId || card.id || raw.id || raw.note_id || '');
  if (!id) return null;

  const title = card.display_title || card.displayTitle || card.title || card.desc || '';
  const author = (card.user && (card.user.nickname || card.user.nick_name)) || ctx.author || '';
  const token = card.xsec_token || card.xsecToken || raw.xsec_token || raw.xsecToken || ctx.xsecToken || '';
  const assets = [];
  const seen = new Set();
  const addAsset = (a) => {
    if (!a || !a.url || seen.has(a.url)) return;
    seen.add(a.url);
    assets.push(a);
  };

  const list = card.image_list || card.imageList || [];
  for (const img of list) {
    const raw = U.absUrl(pickImageRaw(img));
    const still = U.originalImageUrl(raw);
    // 原图域名偶尔会拒，保留平台页面正在用的地址作为回退
    const fallback = raw && raw !== still ? raw : '';
    // 实况图有三种字段写法：接口里的 video、详情页 state 里的 stream、以及 live_photo 里的 video
    const motion = pickBestStream(
      img.video || img.stream || img.live_video || img.liveVideo || (img.live_photo && img.live_photo.video) || null
    );
    const isLive = !!(img.live_photo || img.livePhoto || img.stream || img.video);
    // 实况图：静态图 + 同一帧的动态视频
    if (motion && isLive) {
      addAsset({ kind: 'live', url: motion, still, ext: 'mp4' });
    } else if (still) {
      addAsset({ kind: 'image', url: still, still, fallback, ext: '' });
    }
  }

  const videoUrl = pickBestStream(card.video);
  if (videoUrl && !assets.some((a) => a.kind === 'video' || a.kind === 'live')) {
    addAsset({ kind: 'video', url: videoUrl, still: pickImageUrl(card.cover), ext: 'mp4' });
  }

  const tsRaw = Number(card.time || card.create_time || card.createTime || 0);
  const createdAt = tsRaw > 1e12 ? tsRaw : tsRaw > 1e9 ? tsRaw * 1000 : 0;

  const item = U.makeItem({
    id,
    platform: 'xhs',
    title: title || `笔记 ${id}`,
    desc: card.desc || '',
    author,
    pageUrl: noteUrl(id, token),
    cover: U.displayImageUrl(pickImageRaw(card.cover)) || (assets[0] && (assets[0].still || assets[0].url)) || '',
    createdAt,
    assets,
    type: card.type === 'video' && videoUrl ? 'video' : undefined,
  });
  item._xsecToken = token;
  return item;
}

module.exports = {
  id: 'xhs',
  name: '小红书',
  accent: '#FF2E4D',
  homeUrl: HOST,

  matchUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/xhslink\.com\//i.test(raw)) return { shortUrl: U.absUrl(raw) };
    const m = /xiaohongshu\.com\/user\/profile\/([0-9a-zA-Z]+)/i.exec(raw);
    if (m) {
      const tokenMatch = /[?&]xsec_token=([^&]+)/i.exec(raw);
      return {
        userId: m[1],
        xsecToken: tokenMatch ? decodeURIComponent(tokenMatch[1]) : '',
        profileUrl: U.absUrl(raw.startsWith('http') ? raw : 'https://' + raw),
      };
    }
    if (/xiaohongshu\.com\/user\/profile\//i.test(raw)) return { profileUrl: U.absUrl(raw) };
    return null;
  },

  /** 作者主页作品列表接口 */
  listMatchers: [/\/api\/sns\/web\/v1\/user_posted/i],
  /** 作品的标准打开地址（页面里有时给的是 /user/profile/<uid>/<id> 这种，会落回主页） */
  pageUrlFor(id, token) {
    return noteUrl(String(id || ''), token || '');
  },
  /** 作品详情接口（列表接口不含图集详情时使用） */
  detailMatchers: [
    /\/api\/sns\/web\/v1\/feed/i,
    /\/api\/sns\/web\/v1\/note\//i,
    /\/api\/sns\/h5\/v1\/note_info/i,
  ],

  parseList(json, ctx) {
    const notes = (json && json.data && (json.data.notes || (json.data.data && json.data.data.notes))) || [];
    const author = (json && json.data && json.data.user && json.data.user.nickname) || ctx.author || '';
    const items = notes.map((n) => normalizeNote(n, { ...ctx, author })).filter(Boolean);
    const hasMore = json && json.data ? json.data.has_more !== false : false;
    return { items, hasMore, author };
  },

  parseDetail(json) {
    const items = (json && json.data && (json.data.items || (json.data.data && json.data.data.items))) || [];
    const out = [];
    for (const it of items) {
      const n = normalizeNote(it.note_card || it, {});
      if (n) out.push(n);
    }
    return out;
  },

  /**
   * 详情页必须带 xsec_token，否则一定跳 404「当前笔记暂时无法浏览」。
   * 优先直接用列表页里抓到的真实链接（/user/profile/<uid>/<noteId>?xsec_token=...），
   * 那是页面自己生成的，权限一定对。
   */
  detailUrl(item) {
    const p = String(item.pageUrl || '');
    if (/xiaohongshu\.com\/(explore|discovery\/item)\/[0-9a-zA-Z]+/.test(p) && /[?&]xsec_token=/.test(p)) return p;
    if (/xiaohongshu\.com\/user\/profile\/[^/]+\/[0-9a-zA-Z]{16,}/.test(p) && /[?&]xsec_token=/.test(p)) return p;
    return noteUrl(item.id, item._xsecToken || '');
  },

  needsDetail(item) {
    return !item.assets || item.assets.length === 0;
  },

  /**
   * 直连取一条笔记的完整详情。
   *
   * 走「直接 GET 笔记页 SSR HTML」而不是在浏览器里逐条打开：
   * 后者一次 2～4 秒（还得等水合），前者 370ms/条（实测 8 并发 8 条共 2.8 秒），
   * 而且 __INITIAL_STATE__ 里的数据完全一样 —— Live 实况图的静图 + 视频配对、
   * 完整标题、正文、作者、发布时间都能拿到。
   */
  async fetchDetail(host, item) {
    const url = this.detailUrl(item);
    // 没有 xsec_token 的笔记页一律 404，白跑一趟
    if (!/[?&]xsec_token=/.test(url)) return [];
    const html = await host.fetchPageHtml(url, { referer: `${HOST}/`, timeout: 12000 });
    if (!html) return [];
    const note = noteFromStateHtml(html, item.id);
    if (!note) return [];
    const it = normalizeNote(note, { xsecToken: item._xsecToken || '' });
    if (!it || !it.assets.length) return [];
    it.id = item.id || it.id;
    it._xsecToken = item._xsecToken || it._xsecToken || '';
    if (!it.pageUrl) it.pageUrl = url;
    return [it];
  },

  /**
   * 解析阶段预取详情：把 Live 实况图和完整元数据补进解析结果。
   *
   * 为什么必须有这一步：小红书作者主页的列表接口 `user_posted` 里
   * **一条笔记的 image_list 都没有**（只有封面），所以只靠列表数据，
   * 界面上分不出「Live 实况图」和「普通图片」，徽标只能写「图片」，
   * 动态那半段视频也永远拿不到。
   */
  async prefetchDetails(host, items, opts = {}) {
    const concurrency = Math.max(1, Math.min(8, opts.concurrency || 5));
    const list = (items || []).filter((it) => it && it.id && !(it.assets && it.assets.length));
    const stat = { total: list.length, done: 0, ok: 0, live: 0 };
    if (!list.length) return stat;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= list.length) return;
        const item = list[idx];
        try {
          const parsed = await this.fetchDetail(host, item);
          const hit = (parsed || []).find((p) => p.id === item.id) || (parsed || [])[0];
          if (hit && hit.assets && hit.assets.length) {
            item.assets = hit.assets;
            item.type = hit.type;
            if (!item.cover) item.cover = hit.cover;
            if (!item.title || /^(笔记|小红书)\s/.test(item.title)) item.title = hit.title;
            if (!item.author) item.author = hit.author;
            if (!item.desc) item.desc = hit.desc;
            if (!item.createdAt) item.createdAt = hit.createdAt;
            item._detailFetched = true;
            stat.ok++;
            if (hit.type === 'live') stat.live++;
          }
        } catch {
          // 单条失败不影响其它条目，下载前还有一轮兜底
        }
        stat.done++;
        if (opts.onProgress) opts.onProgress({ done: stat.done, total: stat.total, live: stat.live });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return stat;
  },

  /**
   * 从详情页初始状态里的节点取媒体。
   * 小红书笔记页现在**不发 feed 接口**（SSR + 客户端 store，实测只有 metrics_report 之类的上报），
   * 所以 state 是唯一能拿到「实况图静图 + 视频」配对的地方，这里复用 normalizeNote 的判定规则。
   */
  assetsFromState(node, id) {
    // state 里的节点层级不固定：有时是 feed 包裹层 { id, noteCard }，有时外面还套一层 { note }
    const cands = [];
    const push = (n) => {
      if (n && typeof n === 'object' && !cands.includes(n)) cands.push(n);
    };
    push(node);
    if (node) {
      push(node.note);
      push(node.noteCard);
      push(node.note_card);
      push(node.card);
    }
    for (const c of cands.slice()) {
      push(c.note);
      push(c.noteCard);
      push(c.note_card);
    }
    for (const cand of cands) {
      const nid = cand.noteId || cand.note_id || cand.id;
      if (!nid || (id && String(nid) !== String(id))) continue;
      const it = normalizeNote(cand, {});
      if (it && it.assets.length) return it.assets;
    }
    return [];
  },

  referer: HOST + '/',
  normalizeNote,
  mediaFromHtml,
  noteFromStateHtml,
};
