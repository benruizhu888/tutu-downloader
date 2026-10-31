'use strict';

const { WebContentsView, session, shell } = require('electron');
const { Sniffer, extractEmbeddedState } = require('./sniffer');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 各平台「作品卡片」的 DOM 特征。
 * 接口不一定每次都抓得到（小红书主页改成了首屏 SSR + 懒加载），
 * 但页面上的卡片一定在，所以留一条 DOM 兜底通道。
 */
const CARD_CONF = {
  xhs: {
    cardSel: 'section.note-item, .note-item, [data-note-id]',
    // 作者作品流的容器。主页往下滚到底会插入「推荐」块，必须限定在这个容器里，
    // 否则别人的作品会被当成该作者的（实测会多出 5 条）。
    scopeSel: '#userPostedFeeds',
    // 卡片里有两三条链接，必须挑「带 xsec_token 的封面链接」，
    // 隐藏的 a[href="/explore/<id>"] 不带 token，打开就是 404。
    linkSel: 'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/user/profile/"]',
    idAttr: 'data-note-id',
    idRe: '(?:explore|discovery\\/item)\\/([0-9a-zA-Z]{16,})|\\/user\\/profile\\/[0-9a-zA-Z]+\\/([0-9a-zA-Z]{16,})',
    titleSel: '.footer .title, .title',
    // 作者自己的卡片不显示作者名，「推荐」位的卡片会显示，正好用来过滤
    cardAuthorSel: '.author .name, .author-wrapper .name, .author-name, .user-name',
    imgSel: 'a.cover img, img',
    videoSel: '[class*="play-icon"], .play-icon, [class*="video-icon"]',
    authorSel: '.user-name, .user-nickname, .user .name',
  },
  weibo: {
    cardSel: 'div[mid], .card-wrap, article',
    linkSel: 'a[href*="/status/"], a[href*="/detail/"]',
    idRe: '(?:status|detail)\\/([0-9a-zA-Z]{8,})',
    attrId: 'mid',
    attrIdRe: '^\\d{6,}$',
    titleSel: '.weibo-text, .txt, [class*="detail_wbtext"]',
    imgSel: 'img[src*="sinaimg"], img',
    videoSel: 'video, [class*="video"]',
    authorSel: '.ProfileHeader_name, [class*="nick"], .username',
  },
  douyin: {
    cardSel: 'li[data-e2e="scroll-list-item"], ul[data-e2e="scroll-list"] li, [data-e2e="user-post-item"]',
    linkSel: 'a[href*="/video/"], a[href*="/note/"]',
    idRe: '(?:video|note)\\/(\\d{15,})',
    titleSel: '[data-e2e="video-desc"], .title',
    imgSel: 'img',
    videoSel: '[data-e2e="video-cover"], video, [class*="play"]',
    authorSel: '[data-e2e="user-title"], h1',
  },
};

/**
 * 每个平台一个独立的内嵌浏览器（独立 session 分区，互不串号）。
 * 负责：加载主页、执行页内脚本、滚动加载、抓取接口响应、取 HTML 内嵌状态。
 */
class BrowserHost {
  constructor(win, platform) {
    this.win = win;
    this.platform = platform;
    this.session = session.fromPartition(`persist:tutu-${platform.id}`);
    this.session.setUserAgent(DESKTOP_UA);
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    /** 登录态可能变化时的回调（页面加载完 / 站内跳转 / 轮询） */
    this.onLoginMaybeChanged = null;
    this._loginNotifyAt = 0;
    this._loginWatch = null;

    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: require('path').join(__dirname, '..', 'preload', 'view-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.view.setBackgroundColor('#ffffff');
    const wc = this.view.webContents;
    wc.setUserAgent(DESKTOP_UA);
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    // 页面里可能夹着 bitbrowser:// 之类的外部协议链接，
    // 直接放行会弹出「要用哪个应用打开」的系统对话框，把应用卡住。
    wc.on('will-navigate', (e, url) => {
      if (!/^(https?|about|data|blob):/i.test(String(url || ''))) e.preventDefault();
    });
    wc.on('will-frame-navigate', (e, url, _code, _status, isMainFrame) => {
      if (!isMainFrame) return;
      if (!/^(https?|about|data|blob):/i.test(String(url || ''))) e.preventDefault();
    });
    // 站内偶发证书/网络错误不弹窗打断用户
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && this.onLoadError) this.onLoadError({ code, desc, url });
    });
    // 每次加载完成都把「一键解析」按钮补回去（站内跳转不会丢，但换页会）
    wc.on('did-finish-load', () => this.injectParseButton());
    wc.on('did-finish-load', () => this.sniffInstall());
    wc.on('did-navigate-in-page', () => this.injectParseButton());
    // 登录成功往往伴随页面跳转/刷新，这里主动复核一次登录态回传给界面
    wc.on('did-finish-load', () => this.notifyLoginMaybeChanged());
    wc.on('did-navigate-in-page', () => this.notifyLoginMaybeChanged());

    this.sniffer = new Sniffer(wc);
    win.contentView.addChildView(this.view);
    this.view.setVisible(false);
    // 必须尽早挂上调试协议，否则页面首屏的接口请求一个都抓不到
    try {
      this.sniffer.attach();
    } catch (e) {
      console.warn('[sniffer] attach failed', e && e.message);
    }
  }

  get webContents() {
    return this.view.webContents;
  }

  setBounds(rect) {
    const b = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    const dx = Math.abs(b.x - this.bounds.x);
    const dy = Math.abs(b.y - this.bounds.y);
    const moved = dx > 0 || dy > 0;
    const resized = b.width !== this.bounds.width || b.height !== this.bounds.height;
    this.bounds = b;
    if (!this.visible) return;
    if (dx > 24 || dy > 24) {
      // 大幅位移时直接 setBounds 会留下上一帧的残影（页面看起来被画了两遍），
      // 先隐藏再设位置可以强制整块重绘。1~2px 的抖动不值得闪这一下，走下面的 invalidate。
      this.view.setVisible(false);
      this.view.setBounds(b);
      this.view.setVisible(true);
    } else {
      this.view.setBounds(b);
    }
    if (moved || resized) {
      try { this.view.webContents.invalidate(); } catch {}
    }
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.view.setBounds(this.bounds);
    this.view.setVisible(true);
    try { this.view.webContents.invalidate(); } catch {}
    this.startLoginWatch();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.view.setVisible(false);
    this.stopLoginWatch();
  }

  /**
   * 复核登录态并回调上层。
   * 1.5s 内只跑一次：did-finish-load 与 did-navigate-in-page 经常连着来，
   * 不节流会连着打两次 executeJavaScript。
   */
  notifyLoginMaybeChanged() {
    if (typeof this.onLoginMaybeChanged !== 'function') return;
    const now = Date.now();
    if (now - this._loginNotifyAt < 1500) return;
    this._loginNotifyAt = now;
    Promise.resolve()
      .then(() => this.onLoginMaybeChanged())
      .catch(() => {});
  }

  /**
   * 可见期间低频轮询。
   * 小红书等平台扫码登录后可能只做局部刷新、不触发导航事件，
   * 只靠 did-finish-load 会漏掉，这里补一条兜底通道。
   * 视图隐藏时立即停表，不在后台空转。
   */
  startLoginWatch() {
    if (this._loginWatch) return;
    this._loginWatch = setInterval(() => this.notifyLoginMaybeChanged(), 5000);
  }

  stopLoginWatch() {
    if (!this._loginWatch) return;
    clearInterval(this._loginWatch);
    this._loginWatch = null;
  }

  destroy() {
    this.stopLoginWatch();
    try { this.sniffer.detach(); } catch {}
    try { this.win.contentView.removeChildView(this.view); } catch {}
    try { this.view.webContents.close(); } catch {}
  }

  /** 载入页面；已在该地址则直接返回 */
  async load(url, { timeout = 30000, force = false } = {}) {
    const wc = this.view.webContents;
    const current = wc.getURL();
    if (!force && current && sameUrl(current, url)) return;

    // 等调试协议的网络域就绪再导航：否则首屏那批接口请求没有 requestWillBeSent，
    // 后面只能收到 loadingFinished，既拿不到 url 也拿不到响应体（列表直接少一页）。
    try { await this.sniffer.ready(); } catch {}

    const go = (retried) =>
      new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          wc.removeListener('did-finish-load', onLoad);
          wc.removeListener('did-fail-load', onFail);
          err ? reject(err) : resolve();
        };
        const onLoad = () => setTimeout(() => finish(null), 350);
        const onFail = (_e, code, desc, _url, isMain) => {
          if (!isMain) return; // 子框架（广告位等）失败不影响整页
          if (code === -3) return; // 被主动中止（换页/切平台），不算失败
          finish(new Error(`页面加载失败（${desc || code}）`));
        };
        const timer = setTimeout(() => finish(new Error('页面加载超时，请检查网络或重新登录')), timeout);
        wc.once('did-finish-load', onLoad);
        wc.on('did-fail-load', onFail);
        wc.loadURL(url).catch((e) => {
          // 切换平台时上一次导航会被打断，loadURL 会顺带抛出 ERR_ABORTED。
          // 这里区分两种情况：真的到目标页了就当成功，没到就重发一次干净的导航。
          const msg = String((e && e.message) || e);
          if (/ERR_ABORTED|\(-3\)/.test(msg)) {
            const now = wc.getURL();
            if (sameUrl(now, url)) { finish(null); return; }
            if (!retried) {
              done = true;
              clearTimeout(timer);
              wc.removeListener('did-finish-load', onLoad);
              wc.removeListener('did-fail-load', onFail);
              setTimeout(() => go(true).then(resolve, reject), 400);
              return;
            }
          }
          finish(e);
        });
      });

    await go(false);
  }

  async eval(js) {
    return this.view.webContents.executeJavaScript(js, true);
  }

  /** 在页面上下文里发请求：自带 Cookie 与同源身份 */
  async pageFetchText(url, { timeout = 20000 } = {}) {
    const js = `(() => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ${Math.max(1000, timeout - 500)});
      return fetch(${JSON.stringify(url)}, { credentials: 'include', signal: ctrl.signal })
        .then(r => r.text().then(text => ({ ok: r.ok, status: r.status, text })))
        .catch(e => ({ ok: false, status: 0, text: '', error: String(e && e.message || e) }))
        .finally(() => clearTimeout(t));
    })()`;
    return this.eval(js);
  }

  /**
   * 直接 GET 一个页面的 HTML（带 Cookie 与 Referer），**不占用右侧内嵌视图**。
   *
   * 用途：小红书的作者主页列表接口只给封面（连 image_list 都没有），
   * 想知道一条笔记是 Live 实况图还是普通图片、想要完整标题/作者，
   * 只有作品详情页里才有。而「在浏览器里逐条打开详情页」一次要 2～4 秒，
   * 76 条作品根本跑不完；直接 GET 笔记页的 SSR HTML 只要 370ms/条，
   * 实测 8 并发 8 条共 2.8 秒，同样能拿到 __INITIAL_STATE__ 里的 Live 视频流。
   */
  async fetchPageHtml(url, { referer = '', timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(2000, timeout));
    try {
      const headers = {};
      if (referer) headers.Referer = referer;
      const res = await this.session.fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
      if (!res || !res.ok) return '';
      return await res.text();
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 读取当前页面的初始状态。
   *
   * 两条路都走：
   * 1) HTML 里的 `<script>window.__INITIAL_STATE__=…</script>`（首屏 SSR）
   * 2) 运行时的 `window.__INITIAL_STATE__`（SPA 水合之后才有内容）
   * 小红书笔记页正好落在 2 上：首屏 HTML 里只有框架数据，作品详情是客户端塞进 store 的，
   * 只读 HTML 会一无所获（实测 0 条），实况图的视频因此一直拿不到。
   */
  async embeddedState() {
    const out = [];
    try {
      const html = await this.eval('document.documentElement.outerHTML');
      out.push(...extractEmbeddedState(html));
    } catch {}
    try {
      out.push(...(await this.runtimeState()));
    } catch {}
    return out;
  }

  /** 把页面里的全局状态对象序列化回来（限制体积，跳过函数与循环引用） */
  async runtimeState() {
    const js = `(() => {
      const keys = ['__INITIAL_STATE__', '__NUXT__', '_ROUTER_DATA', '__RENDER_DATA__'];
      const out = [];
      for (const k of keys) {
        try {
          const v = window[k];
          if (!v || typeof v !== 'object') continue;
          // 页面状态里常有循环引用和 Map/Set，直接 stringify 会抛错整块丢掉，
          // 这里用 seen 集合把环切断，尽量把数据带回来
          const seen = new WeakSet();
          const s = JSON.stringify(v, (key, val) => {
            if (typeof val === 'function') return undefined;
            if (val instanceof Map || val instanceof Set) return null;
            if (val && typeof val === 'object') {
              if (seen.has(val)) return null;
              seen.add(val);
            }
            return val;
          });
          if (s && s.length > 2 && s.length < 4000000) out.push(s);
        } catch (e) {}
      }
      return out;
    })()`;
    const rows = await this.eval(js).catch(() => []);
    const parsed = [];
    for (const s of Array.isArray(rows) ? rows : []) {
      try {
        parsed.push(JSON.parse(s));
      } catch {}
    }
    return parsed;
  }

  /**
   * 滚动一屏并返回度量。
   * 有些页面用内部容器滚动，所以先找出「可滚动距离最大」的容器再滚它。
   */
  async scrollStep(ratio = 0.85) {
    return this.eval(`(() => {
      const doc = document.scrollingElement || document.documentElement;
      let target = doc;
      let best = Math.max(0, doc.scrollHeight - doc.clientHeight);
      for (const el of document.querySelectorAll('div, main, section, article')) {
        const st = getComputedStyle(el);
        if (!/auto|scroll/.test(st.overflowY)) continue;
        const d = el.scrollHeight - el.clientHeight;
        if (d > best + 40) { best = d; target = el; }
      }
      const step = Math.max(320, Math.round(window.innerHeight * ${Number(ratio)}));
      const before = target.scrollHeight;
      const yBefore = target.scrollTop;
      target.scrollBy({ top: step, behavior: 'instant' });
      if (target === doc) window.scrollBy(0, 0);
      return {
        before, after: target.scrollHeight, y: target.scrollTop, yBefore,
        viewport: window.innerHeight, total: target.scrollHeight,
        inWindow: target === doc,
        moved: target.scrollTop - yBefore,
        atBottom: target.scrollTop + target.clientHeight >= target.scrollHeight - 8,
      };
    })()`);
  }

  async scrollToTop() {
    return this.eval("window.scrollTo({top:0,behavior:'instant'}); 1");
  }

  // ---------- DOM 兜底提取 ----------

  /**
   * 扫描页面已渲染的作品卡片。
   * 返回 { author, cards:[{ id, title, cover, isVideo, token, href }] }
   */
  async domCards(platformId) {
    const conf = CARD_CONF[platformId];
    if (!conf) return { author: '', cards: [] };
    try {
      const res = await this.eval(cardsScript(conf));
      if (!res || !Array.isArray(res.cards)) return { author: '', cards: [] };
      return res;
    } catch {
      return { author: '', cards: [] };
    }
  }

  /** 读当前页面 HTML（有些平台的媒体地址只存在于脚本数据里） */
  async pageHtml() {
    try {
      return await this.eval('document.documentElement.outerHTML');
    } catch {
      return '';
    }
  }

  /** 详情弹层 / 详情页里已经渲染出来的媒体（最后一级兜底） */
  async detailDomMedia() {
    const scopeSel = DETAIL_SCOPE[this.platform.id];
    if (!scopeSel) return { images: [], videos: [] };
    try {
      const res = await this.eval(DETAIL_MEDIA_JS(scopeSel));
      if (!res || typeof res !== 'object') return { images: [], videos: [] };
      return {
        images: Array.isArray(res.images) ? res.images : [],
        videos: Array.isArray(res.videos) ? res.videos : [],
      };
    } catch {
      return { images: [], videos: [] };
    }
  }

  /** 在平台页面右下角挂一个「一键解析」悬浮按钮 */
  async injectParseButton() {
    try {
      return await this.eval(PARSE_BUTTON_JS);
    } catch {
      return 'err';
    }
  }

  /**
   * 在页面里挂一层 fetch / XHR 观察器，直接读回 JSON 响应。
   *
   * 为什么不能只靠 DevTools 抓包：小红书的部分列表请求走 Service Worker，
   * 这类请求只会收到 loadingFinished、收不到 responseReceived，
   * `Network.getResponseBody` 随之报 "No resource with given identifier found"。
   * 实测翻 5 页只成功读到 1 页，作品数就从 71 掉到 30/44。
   * 直接包一层页面自己的 fetch/XHR 读 response，跟页面请求同源同上下文，稳得多。
   */
  async sniffInstall() {
    const pats = (this.platform.listMatchers || []).map((m) => ({
      source: m instanceof RegExp ? m.source : String(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      flags: m instanceof RegExp ? m.flags.replace('g', '') : 'i',
    }));
    if (!pats.length) return 0;
    const code = `(() => {
      const PATS = ${JSON.stringify(pats)};
      const res = PATS.map((p) => new RegExp(p.source, p.flags));
      const hit = (u) => { const s = String(u || ''); return res.some((r) => r.test(s)); };
      window.__tutuSniffed = window.__tutuSniffed || [];
      const push = (u, t) => {
        try {
          if (typeof t !== 'string' || !t) return;
          window.__tutuSniffed.push({ url: String(u || ''), body: t });
          if (window.__tutuSniffed.length > 80) window.__tutuSniffed.shift();
          window.__tutuSniffCount = (window.__tutuSniffCount || 0) + 1;
        } catch (e) {}
      };
      if (!window.__tutuFetchHooked) {
        window.__tutuFetchHooked = true;
        const of = window.fetch;
        if (typeof of === 'function') {
          window.fetch = function (...args) {
            const p = of.apply(this, args);
            try {
              const a0 = args[0];
              const u = typeof a0 === 'string' ? a0 : (a0 && a0.url) || '';
              if (hit(u)) p.then((r) => { try { r.clone().text().then((t) => push(r.url || u, t)).catch(() => {}); } catch (e) {} }).catch(() => {});
            } catch (e) {}
            return p;
          };
        }
        const XO = XMLHttpRequest.prototype.open;
        const XS = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u, ...rest) {
          try { this.__tutuUrl = u; } catch (e) {}
          return XO.call(this, m, u, ...rest);
        };
        XMLHttpRequest.prototype.send = function (...a) {
          try {
            if (hit(String(this.__tutuUrl || ''))) {
              this.addEventListener('load', () => { try { push(this.responseURL || this.__tutuUrl, this.responseText); } catch (e) {} });
            }
          } catch (e) {}
          return XS.apply(this, a);
        };
      }
      return 1;
    })()`;
    try {
      return await this.eval(code);
    } catch {
      return 0;
    }
  }

  /** 把观察器攒下的响应取走（取完即清空），返回 [{url, body}] */
  async sniffDrain() {
    try {
      const raw = await this.eval(`(() => {
        const a = window.__tutuSniffed || [];
        window.__tutuSniffed = [];
        return JSON.stringify(a);
      })()`);
      if (!raw || typeof raw !== 'string') return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /**
   * 用页面自己发请求把文件读成二进制。
   *
   * 主进程的 session.fetch 走的是网络服务进程，个别 CDN（例如 sinaimg）
   * 会按热度、UA、TLS 指纹偶发返回 403；而同一个地址由页面自己 fetch 一定通过。
   * 所以只在「主进程被拒」时用它兜底，并限制大小（base64 传输对视频不合适）。
   */
  async fetchBytes(url, { maxBytes = 12 * 1024 * 1024 } = {}) {
    const js = `(async () => {
      try {
        const r = await fetch(${JSON.stringify(String(url))}, { credentials: 'include' });
        if (!r.ok) return { ok: false, status: r.status };
        const len = Number(r.headers.get('content-length') || 0);
        if (${Number(maxBytes)} > 0 && len > ${Number(maxBytes)}) return { ok: false, status: r.status, tooBig: len };
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!buf.length) return { ok: false, status: r.status, empty: true };
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < buf.length; i += CH) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        }
        return { ok: true, status: r.status, ct: r.headers.get('content-type') || '', b64: btoa(bin) };
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
    })()`;
    try {
      const res = await this.eval(js);
      if (!res || !res.ok || !res.b64) return null;
      return { buffer: Buffer.from(res.b64, 'base64'), contentType: res.ct || '' };
    } catch {
      return null;
    }
  }

  openExternal(url) {
    shell.openExternal(url).catch(() => {});
  }
}

/** 生成「扫描卡片」的页内脚本 */
function cardsScript(conf) {
  return `(() => {
    const conf = ${JSON.stringify(conf)};
    const idRe = new RegExp(conf.idRe, 'i');
    const abs = (h) => { try { return new URL(h, location.href); } catch { return null; } };
    const idOf = (href) => {
      if (!href) return '';
      const u = abs(href);
      if (!u) return '';
      const m = idRe.exec(u.pathname || '');
      return m ? (m[1] || m[2] || '') : '';
    };
    const out = [];
    const seen = new Set();
    // 有 scopeSel 时只扫作者自己的作品流：主页滚到底后平台会插入「推荐」位，
    // 那些是别人的作品，混进来会让左侧数量比主页标称的还多。
    const root = (conf.scopeSel && document.querySelector(conf.scopeSel)) || document;
    for (const el of root.querySelectorAll(conf.cardSel)) {
      let id = conf.idAttr ? (el.getAttribute(conf.idAttr) || '') : '';
      // 一张卡片里可能同时有裸链接和带 xsec_token 的链接，取分数最高的那条
      let best = null;
      let bestScore = -1;
      for (const a of el.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const aid = idOf(href);
        if (!aid) continue;
        let score = 1;
        if (/[?&]xsec_token=/.test(href)) score += 4;
        if (/\\/user\\/profile\\/[^/?]+\\/[^/?]+/.test(href)) score += 2;
        if (a.style && a.style.display === 'none') score -= 5;
        if (id && aid !== id) score -= 3;
        if (score > bestScore) { bestScore = score; best = { href, id: aid }; }
      }
      if (!id && best) id = best.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const u = best ? abs(best.href) : null;
      const img = el.querySelector(conf.imgSel) || el.querySelector('img');
      const tEl = el.querySelector(conf.titleSel);
      const cover = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
      out.push({
        id,
        title: ((tEl && tEl.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        cover,
        // 卡片自己带的作者名：用来剔掉「推荐」位里别人的作品
        author: ((el.querySelector(conf.cardAuthorSel || '') || {}).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        isVideo: !!(conf.videoSel && el.querySelector(conf.videoSel)),
        token: (u && u.searchParams.get('xsec_token')) || '',
        href: u ? u.toString() : '',
      });
    }
    let author = '';
    try {
      const a = document.querySelector(conf.authorSel);
      if (a) author = ((a.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 40);
    } catch {}
    return { author, cards: out };
  })()`;
}

/** 详情页「作品本体」区域。绝不能退回到 body/main，否则会把「相关推荐」的图一起抓下来 */
const DETAIL_SCOPE = {
  xhs: '#noteContainer, [class*="note-detail"], [class*="noteContainer"], [class*="note-scroller"], [class*="media-container"]',
  weibo: 'article, [class*="detail_wbtext"], [class*="Detail"], .main',
  douyin: '[data-e2e="video-detail"], [class*="video-detail"], [class*="detail-container"], main',
};
const DETAIL_MEDIA_JS = (scopeSel) => `(() => {
  const bad = /\\/avatar\\/|sns-avatar|fe-static|fe-platform|picasso-static|\\/emoji\\/|\\/icon\\/|\\/logo\\//i;
  const images = [];
  const videos = [];
  const push = (list, u) => {
    if (!u) return;
    const s = String(u).trim();
    if (!s || bad.test(s)) return;
    if (!/^https?:\\/\\//.test(s) && !s.startsWith('//')) return;
    list.push(s.replace(/&amp;/g, '&'));
  };
  // 只认「作品本体」区域，找不到就返回空：宁可换别的取法，也不要把相关推荐的图算进来
  const scope = document.querySelector(${JSON.stringify(scopeSel)});
  if (!scope) return { images: [], videos: [] };
  for (const img of scope.querySelectorAll('img')) {
    push(images, img.currentSrc || img.src || img.getAttribute('data-src') || '');
  }
  for (const v of scope.querySelectorAll('video')) {
    push(videos, v.currentSrc || v.getAttribute('src') || '');
    for (const s of v.querySelectorAll('source')) push(videos, s.getAttribute('src') || '');
  }
  // 视频笔记的播放器常常懒创建在区域外，补一次全页查找（一页只有一个主播放器）
  if (!videos.length) {
    for (const v of document.querySelectorAll('video')) {
      push(videos, v.currentSrc || v.getAttribute('src') || '');
      for (const s of v.querySelectorAll('source')) push(videos, s.getAttribute('src') || '');
      if (videos.length) break;
    }
  }
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((u) => {
      const k = u.split('#')[0];
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return { images: dedupe(images), videos: dedupe(videos).slice(0, 2) };
})()`;

/** 平台页面右下角的「一键解析」悬浮按钮 */
const PARSE_BUTTON_JS = `(() => {
  const ID = '__tutu_parse_btn';
  if (document.getElementById(ID)) return 'exists';
  const host = document.body || document.documentElement;
  if (!host) return 'no-body';
  const b = document.createElement('button');
  b.id = ID;
  b.type = 'button';
  b.title = '解析当前页面打开的作者主页';
  b.textContent = '🐰 一键解析';
  b.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483000',
    'display:flex', 'align-items:center', 'gap:6px',
    'padding:10px 16px', 'border-radius:999px',
    'border:1px solid rgba(0,0,0,0.08)',
    'background:rgba(255,255,255,0.94)',
    'color:#1d1d1f', 'font-size:13px', 'font-weight:600', 'line-height:1',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
    'box-shadow:0 6px 20px rgba(0,0,0,0.14)',
    'backdrop-filter:blur(14px)', '-webkit-backdrop-filter:blur(14px)',
    'cursor:pointer', 'user-select:none',
    'transition:transform .14s ease,box-shadow .14s ease',
  ].join(';');
  b.addEventListener('mouseenter', () => {
    b.style.transform = 'translateY(-1px)';
    b.style.boxShadow = '0 10px 24px rgba(0,0,0,0.18)';
  });
  b.addEventListener('mouseleave', () => {
    b.style.transform = 'none';
    b.style.boxShadow = '0 6px 20px rgba(0,0,0,0.14)';
  });
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { window.__tutuParseBridge && window.__tutuParseBridge.request(); } catch (err) {}
    b.textContent = '已开始解析…';
    setTimeout(() => { b.textContent = '🐰 一键解析'; }, 2200);
  });
  host.appendChild(b);
  return 'ok';
})()`;

function sameUrl(a, b) {
  const norm = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  return norm(a) === norm(b);
}

module.exports = { BrowserHost, DESKTOP_UA };
