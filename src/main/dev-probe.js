'use strict';

/**
 * 开发期诊断探针（--probe=<url>）：只用于排查解析链路，不参与正式功能。
 *   node tools/launch.js . --probe=https://www.xiaohongshu.com/user/profile/xxx
 *   TUTU_PROBE_NOTE=1  只打开页面，导出请求 / DOM 媒体 / 内嵌状态
 *   TUTU_PROBE_STATE=1 额外导出 DOM 卡片与首张卡片 HTML
 */

const { app } = require('electron');
const { BrowserHost } = require('./browser-host');
const { ProfileParser } = require('./parser');
const platforms = require('./platforms');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortUrl = (u) => String(u).replace(/^https?:\/\/[^/]+/, '').split('?')[0];

async function run({ win }) {
  const arg = process.argv.find((a) => a.startsWith('--probe='));
  const url = arg.slice('--probe='.length);
  const pid = process.env.TUTU_PROBE_PLATFORM
    || (/xiaohongshu/.test(url) ? 'xhs' : /weibo/.test(url) ? 'weibo' : 'douyin');
  const adapter = platforms.get(pid);
  const host = new BrowserHost(win, adapter);
  const b = win.getContentBounds();
  host.setBounds({ x: Math.round(b.width * 0.55), y: 130, width: 430, height: 620 });
  host.show();
  const out = { platform: pid, url };

  const finish = () => {
    process.stdout.write('PROBE_RESULT=' + JSON.stringify(out) + '\n', () => app.exit(0));
  };

  try {
    await host.load(url, { timeout: 45000, force: true });
    await sleep(process.env.TUTU_PROBE_QUICK ? 800 : 3200);

    out.loadedUrl = host.webContents.getURL();
    out.title = await host.eval('document.title').catch(() => '');

    // 通用下载通道诊断：给定 URL，逐种方式看谁能真的把 Referer 送出去
    if (process.env.TUTU_PROBE_FETCH) {
      const target = process.env.TUTU_PROBE_FETCH;
      const ref = process.env.TUTU_PROBE_REFERER || 'https://www.douyin.com/';
      out.fetchTest = {};
      const tryIt = async (tag, opts) => {
        try {
          const r = await host.session.fetch(target, opts);
          let body = '';
          if (r.status >= 400) body = (await r.text()).replace(/\s+/g, ' ').slice(0, 90);
          out.fetchTest[tag] = { status: r.status, len: r.headers.get('content-length'), body };
        } catch (e) {
          out.fetchTest[tag] = 'ERR ' + String(e && e.message);
        }
      };
      await tryIt('bare', {});
      await tryIt('header-Referer', { headers: { Referer: ref } });
      await tryIt('header-lower', { headers: { referer: ref } });
      await tryIt('referrer-opt', { referrer: ref });
      out.fetchTest.page = await host
        .eval(`fetch(${JSON.stringify(target)}, { credentials: 'include' })
          .then(r => ({ status: r.status, len: r.headers.get('content-length') }))
          .catch(e => 'ERR ' + String(e && e.message))`)
        .catch((e) => 'ERR ' + e.message);
      return finish();
    }
    out.requests = [...new Set(host.sniffer.urls.map(shortUrl))].filter((u) => !/^chrome-extension/.test(u)).slice(-40);
    const media = await host.detailDomMedia();
    out.domImages = media.images.slice(0, 8);
    out.domVideos = media.videos.slice(0, 4);
    out.stateDump = await host.eval(`(() => {
      const pick = (o) => { try { return o && JSON.parse(JSON.stringify(o)); } catch { return null; } };
      const st = pick(window.__INITIAL_STATE__) || {};
      const keys = Object.keys(st).slice(0, 20);
      return { stateKeys: keys, noteKeys: st.note ? Object.keys(st.note).slice(0, 20) : null, routerKeys: st.global ? Object.keys(st.global).slice(0, 10) : null };
    })()`).catch(() => null);

    out.htmlStats = await host.eval(`(() => {
      const html = document.documentElement.outerHTML;
      const grab = (re, n) => {
        const out = [];
        let m;
        while ((m = re.exec(html)) && out.length < (n || 4)) out.push(m[0].slice(0, 160));
        return out;
      };
      return {
        len: html.length,
        videoUrls: grab(/https:\\/\\/[^"'\\\\ ]*sns-video[^"'\\\\ ]*/g, 4),
        masterUrls: grab(/masterUrl[^,]{0,120}/g, 3),
        h264: (html.match(/h264/gi) || []).length,
        webpic: grab(/https:\\/\\/[^"'\\\\ ]*xhscdn\\.com[^"'\\\\ ]*/g, 6),
        markers: ['__INITIAL_STATE__', '__INITIAL_SSR_STATE__', '__NUXT__', '_ROUTER_DATA', '__NEXT_DATA__'].filter((k) => html.includes(k)),
        noteContainer: !!document.querySelector('#noteContainer'),
        videoTags: document.querySelectorAll('video').length,
        bgImages: [...document.querySelectorAll('[style*="background-image"]')].slice(0, 3).map((e) => e.getAttribute('style').slice(0, 140)),
      };
    })()`).catch((e) => 'ERR ' + e.message);

    if (process.env.TUTU_PROBE_DOUYIN) {
      out.skipped = 'TUTU_PROBE_DOUYIN';
      out.domShape = await host.eval(`(() => {
        const q = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
        const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean);
        const userLinks = links.filter((h) => /\\/user\\//.test(h)).slice(0, 8);
        const videoLinks = links.filter((h) => /\\/video\\//.test(h)).slice(0, 5);
        const e2e = [...new Set([...document.querySelectorAll('[data-e2e]')].map((e) => e.getAttribute('data-e2e')))].slice(0, 40);
        return {
          href: location.href, title: document.title,
          counts: {
            a: links.length,
            userLinks: links.filter((h) => /\\/user\\//.test(h)).length,
            videoLinks: links.filter((h) => /\\/video\\//.test(h)).length,
            loginBtn: q('[data-e2e="login-btn"], .login-button'),
            avatar: q('img[src*="aweme-avatar"], [class*="avatar"]'),
            scrollItems: q('li[data-e2e="scroll-list-item"]'),
            userPost: q('[data-e2e="user-post-item"]'),
          },
          userLinks, videoLinks, e2e,
          bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
        };
      })()`).catch((e) => 'ERR ' + e.message);
      // 页面 HTML 里有没有可直接用的作者标识（用于找「任意一个」作者主页做链路核验）
      out.htmlHits = await host.eval(`(() => {
        const h = document.documentElement.outerHTML;
        const grab = (re, n) => { const o = []; let m; while ((m = re.exec(h)) && o.length < n) o.push(m[1] || m[0]); return o; };
        return {
          len: h.length,
          secUids: grab(/"sec_uid"\\s*:\\s*"([^"]{20,})"/g, 5),
          awemeIds: grab(/"aweme_id"\\s*:\\s*"?(\\d{15,})"?/g, 5),
          nicknames: grab(/"nickname"\\s*:\\s*"([^"]{1,24})"/g, 5),
          userHrefs: grab(/\\/user\\/([A-Za-z0-9_-]{20,})/g, 5),
        };
      })()`).catch((e) => 'ERR ' + e.message);

      // 「我」的入口：点左上角头像通常能拿到自己的主页地址
      out.selfTry = await host.eval(`(async () => {
        const out = {};
        try {
          const r = await fetch('/aweme/v1/web/im/user/info/', { credentials: 'include', headers: { Accept: 'application/json' } });
          out.imStatus = r.status;
          const t = await r.text();
          let j = null;
          try { j = JSON.parse(t); } catch {}
          out.im = {
            head: t.slice(0, 80),
            keys: j ? Object.keys(j).slice(0, 12) : null,
            // 找自己的 sec_uid / uid，用来构造「我的主页」地址
            secUid: j ? JSON.stringify(j).match(/"sec_uid":"([^"]+)"/)?.[1] || '' : '',
            uid: j ? JSON.stringify(j).match(/"uid":"?(\d+)"?/)?.[1] || '' : '',
          };
        } catch (e) { out.imStatus = 'ERR'; }
        try {
          const st = window._ROUTER_DATA || {};
          out.routerKeys = Object.keys(st).slice(0, 10);
        } catch {}
        try {
          const keys = Object.keys(window).filter((k) => /ROUTER_DATA|INITIAL|SSR/i.test(k));
          out.globals = keys.slice(0, 10);
        } catch {}
        return out;
      })()`).catch((e) => 'ERR ' + e.message);
      return finish();
    }

    if (process.env.TUTU_PROBE_WEIBO) {
      out.skipped = 'TUTU_PROBE_WEIBO';
      // 1) DOM 结构：微博主页改过好几轮，选择器不能靠猜
      out.domShape = await host.eval(`(() => {
        const q = (s) => document.querySelectorAll(s).length;
        const sels = ['[mid]', 'article', '.card-wrap', '[action-type]', '[class*="card"]',
          '[class*="feed"]', '[class*="Feed"]', 'a[href*="/status/"]', 'a[href*="/detail/"]',
          'img[src*="sinaimg"]', '[class*="woo-box"]'];
        const counts = {};
        for (const s of sels) { try { counts[s] = q(s); } catch { counts[s] = -1; } }
        // 找到「包含 sinaimg 图 + status 链接」的最小重复容器
        const sample = [];
        for (const a of document.querySelectorAll('a[href*="/status/"]')) {
          let el = a;
          for (let i = 0; i < 8 && el; i++) el = el.parentElement;
          if (!el) continue;
          sample.push({
            href: a.getAttribute('href').slice(0, 120),
            ancestorPath: [a.parentElement, a.parentElement && a.parentElement.parentElement,
              a.parentElement && a.parentElement.parentElement && a.parentElement.parentElement.parentElement]
              .filter(Boolean).map((n) => n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + (n.getAttribute && n.getAttribute('mid') ? '[mid=' + n.getAttribute('mid') + ']' : '')).slice(0, 3),
            imgs: [...a.querySelectorAll('img')].length,
          });
          if (sample.length >= 6) break;
        }
        return { counts, sample, bodyClass: document.body.className.slice(0, 120) };
      })()`).catch((e) => 'ERR ' + e.message);

      // 2) 页内直连接口：微博的 mymblog 只要 Cookie，不需要签名
      out.api = await host.eval(`(async () => {
        const uid = (location.pathname.match(/\\/u\\/(\\d+)/) || [])[1] || '';
        const tries = [
          '/ajax/statuses/mymblog?uid=' + uid + '&page=1&feature=0',
          '/ajax/profile/info?uid=' + uid,
        ];
        const res = {};
        for (const u of tries) {
          try {
            const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
            const t = await r.text();
            let j = null;
            try { j = JSON.parse(t); } catch {}
            res[u.split('?')[0]] = {
              status: r.status,
              len: t.length,
              head: t.slice(0, 60),
              ok: j && j.ok,
              keys: j ? Object.keys(j).slice(0, 10) : null,
              dataKeys: j && j.data ? Object.keys(j.data).slice(0, 12) : null,
              listLen: j && j.data && Array.isArray(j.data.list) ? j.data.list.length : null,
              total: j && j.data ? j.data.total : null,
            };
          } catch (e) { res[u] = 'ERR ' + String(e && e.message); }
        }
        return res;
      })()`).catch((e) => 'ERR ' + e.message);

      // 3) 嗅探器到底有没有拿到 mymblog 的响应体
      out.sniffLog = (host.sniffer.log || []).filter((x) => /mymblog|profile/.test(x.url)).slice(-8);

      // 4) 那条微博的媒体字段长什么样：决定 normalizeStatus 该按哪条分支取
      out.mymblogSample = await host.eval(`(async () => {
        const uid = (location.pathname.match(/\\/u\\/(\\d+)/) || [])[1] || '';
        const r = await fetch('/ajax/statuses/mymblog?uid=' + uid + '&page=1&feature=0', { credentials: 'include' });
        const j = await r.json();
        const list = (j && j.data && j.data.list) || [];
        const out = { listLen: list.length, total: j && j.data && j.data.total, shape: [], items: [] };
        if (list[0]) out.shape = Object.keys(list[0]).slice(0, 24);
        for (const raw of list.slice(0, 3)) {
          const s = raw.mblog || raw;
          out.items.push({
            id: String(s.idstr || s.id || ''),
            text: String(s.text_raw || s.text || '').replace(/<[^>]+>/g, '').slice(0, 60),
            keys: Object.keys(s).filter((k) => /pic|photo|video|page|mix|retweet|media|live/i.test(k)),
            picIds: Array.isArray(s.pic_ids) ? s.pic_ids.length : null,
            picInfos: s.pic_infos ? Object.keys(s.pic_infos).length : null,
            pageInfo: s.page_info ? { type: s.page_info.type, hasMedia: !!s.page_info.media_info, keys: Object.keys(s.page_info).slice(0, 14) } : null,
            mix: s.mix_media_info ? (s.mix_media_info.items || []).map((i) => i.type) : null,
            retweeted: !!s.retweeted_status,
          });
        }
        return out;
      })()`).catch((e) => 'ERR ' + e.message);

      out.sniffBodies = [];

      // 5) 下载通道探针：session.fetch 拿不到图时，到底差了什么头
      if (out.mymblogSample && out.mymblogSample.items && out.mymblogSample.items.length) {
        out.dlTest = await (async () => {
          const imgUrl = out.mymblogSample.items.length && process.env.TUTU_PROBE_IMG;
          const u = imgUrl || '';
          if (!u) return 'set TUTU_PROBE_IMG';
          const res = {};
          const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
          const combos = {
            bare: {},
            ua: { 'User-Agent': UA },
            referer: { 'User-Agent': UA, Referer: 'https://weibo.com/' },
            origin: { 'User-Agent': UA, Referer: 'https://weibo.com/', Origin: 'https://weibo.com' },
            accept: { 'User-Agent': UA, Referer: 'https://weibo.com/', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'cross-site' },
          };
          // 顺带确认：session.fetch 会不会触发 webRequest（决定 Referer 注入为何没生效）
          let hookFired = 0;
          if (process.env.TUTU_PROBE_HOOK) try {
            host.session.webRequest.onBeforeSendHeaders((d, cb) => {
              if (/sinaimg/.test(d.url)) {
                hookFired++;
                d.requestHeaders.Referer = 'https://weibo.com/';
              }
              cb({ requestHeaders: d.requestHeaders });
            });
          } catch (e) { res.hookErr = String(e && e.message); }
          for (const [tag, headers] of Object.entries(combos)) {
            try {
              const r = await host.session.fetch(u, { headers, redirect: 'follow' });
              res[tag] = { status: r.status, ct: r.headers.get('content-type'), len: r.headers.get('content-length') };
            } catch (e) { res[tag] = 'ERR ' + String(e && e.message); }
          }
          res.hookFired = hookFired;
          res.pageFetch = await host.eval(`fetch(${JSON.stringify(u)}, { credentials: 'include' })
            .then(r => ({ status: r.status, ct: r.headers.get('content-type'), len: r.headers.get('content-length') }))
            .catch(e => 'ERR ' + String(e && e.message))`).catch((e) => 'ERR ' + e.message);
          return res;
        })();
      }
      const probe = await host.eval(`(async () => {
        const uid = (location.pathname.match(/\\/u\\/(\\d+)/) || [])[1] || '';
        try {
          const r = await fetch('/ajax/statuses/mymblog?uid=' + uid + '&page=2&feature=0', { credentials: 'include' });
          await r.text();
          return 'sent page2 ' + r.status;
        } catch (e) { return 'ERR ' + String(e && e.message); }
      })()`).catch((e) => 'ERR ' + e.message);
      out.sniffSent = probe;
      await sleep(1500);
      out.sniffLog2 = (host.sniffer.log || []).filter((x) => /mymblog/.test(x.url)).slice(-4);
      return finish();
    }

    if (process.env.TUTU_PROBE_NOTE) {
      out.skipped = 'TUTU_PROBE_NOTE';
      return finish();
    }

    const dom = await host.domCards(pid);
    out.dom = { author: dom.author, count: dom.cards.length, cards: dom.cards.slice(0, 3) };
    out.cardHtml = await host.eval(`(() => {
      const el = document.querySelector('section.note-item, .note-item, [data-note-id], [mid]');
      return el ? el.outerHTML.slice(0, 900) : '';
    })()`).catch(() => '');
    if (!dom.cards.length) {
      out.error = 'DOM 里没有卡片';
      return finish();
    }
    if (process.env.TUTU_PROBE_STATE) {
      out.skipped = 'TUTU_PROBE_STATE';
      return finish();
    }

    const item = { ...dom.cards[0], assets: [], author: dom.author };
    out.detailUrl = adapter.detailUrl(item);
    const parser = new ProfileParser(host, adapter);
    const assets = await parser._resolveOne(item).catch((e) => 'ERR ' + e.message);
    out.resolveAssets = Array.isArray(assets) ? assets.map((a) => ({ kind: a.kind, url: String(a.url).slice(0, 110), still: String(a.still || '').slice(0, 90) })) : assets;
    out.urlAfterResolve = host.webContents.getURL();
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  finish();
}

module.exports = { run };
