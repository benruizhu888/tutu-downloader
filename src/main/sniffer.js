'use strict';

/**
 * 网络响应嗅探器。
 *
 * 为什么需要它：
 * 三个平台的作品列表接口都带风控签名（X-s / a_bogus / XSRF 等），
 * 自己拼请求几乎必然被拦。这里改为「让平台自己的页面去请求」，
 * 通过 DevTools 协议把 JSON 响应体读出来，天然携带合法签名与 Cookie。
 */

class Sniffer {
  /**
   * @param {Electron.WebContents} webContents
   */
  constructor(webContents) {
    this.wc = webContents;
    this.attached = false;
    this.reqs = new Map(); // requestId -> {url, mime, status}
    this.urls = []; // 所有请求 URL（排查用，保留最近 400 条）
    this.log = []; // {url,status,mime} 最近 200 条非静态资源请求
    this.collectors = []; // {matchers, onJson}
    this.waiters = []; // {matchers, resolve, reject, timer, done}
    this.onError = null;
    this.debug = !!process.env.TUTU_SNIFF_DEBUG;
    this._onMessage = this._handleMessage.bind(this);
    this._onDetach = () => { this.attached = false; };
  }

  attach() {
    if (this.attached) return true;
    try {
      this.wc.debugger.attach('1.3');
    } catch (e) {
      if (!/already attached/i.test(String(e && e.message))) throw e;
    }
    this.attached = true;
    this.wc.debugger.on('message', this._onMessage);
    this.wc.debugger.on('detach', this._onDetach);
    // 记下「Network 域真正打开」这件事：没等它生效就导航，首批请求会没有
    // requestWillBeSent，后面虽然能收到 loadingFinished 却拿不到 url 和 body。
    this.readyPromise = this.wc.debugger
      .sendCommand('Network.enable', {
        maxTotalBufferSize: 200 * 1024 * 1024,
        maxResourceBufferSize: 100 * 1024 * 1024,
        maxPostDataSize: 4 * 1024 * 1024,
      })
      .then(() => { this.netReady = true; })
      .catch(() => {});
    return true;
  }

  /** 等 Network 域就绪（导航前调用，避免首批响应抓不到）。最多等 ms，绝不把导航卡死 */
  async ready(ms = 2000) {
    if (this.netReady) return true;
    if (!this.readyPromise) return false;
    await Promise.race([
      this.readyPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, ms)),
    ]);
    return !!this.netReady;
  }

  detach() {
    if (!this.attached) return;
    try { this.wc.debugger.removeListener('message', this._onMessage); } catch {}
    try { this.wc.debugger.removeListener('detach', this._onDetach); } catch {}
    try { this.wc.debugger.detach(); } catch {}
    this.attached = false;
    this.reqs.clear();
    this.collectors = [];
    for (const w of this.waiters) this._settle(w, null);
    this.waiters = [];
  }

  /** 持续收集：主页滚动时把每个匹配的 JSON 都交给回调 */
  setCollector(matchers, onJson) {
    this.collectors.push({ matchers, onJson });
    return () => {
      this.collectors = this.collectors.filter((c) => c.onJson !== onJson);
    };
  }

  /** 单次等待：详情页导航后抓取某个接口 */
  expect(matchers, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { matchers, resolve, reject, done: false, timer: null };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        this._settle(waiter, null);
        reject(new Error('等待页面数据超时'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  _settle(waiter, value) {
    waiter.done = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    this.waiters = this.waiters.filter((w) => w !== waiter);
    if (value !== null && value !== undefined) waiter.resolve(value);
  }

  _match(matchers, url) {
    return (matchers || []).some((m) => (m instanceof RegExp ? m.test(url) : String(url).includes(m)));
  }

  async _handleMessage(event, method, params) {
    if (method === 'Network.requestWillBeSent') {
      const u = (params.request && params.request.url) || '';
      this.reqs.set(params.requestId, { url: u, mime: '', status: 0 });
      if (u && !/\.(png|jpe?g|webp|gif|css|woff2?|ico|svg)(\?|$)/i.test(u)) {
        this.urls.push(u);
        if (this.urls.length > 400) this.urls.shift();
      }
      if (this.debug && /user_posted|aweme\/post|statuses\//.test(u)) {
        console.log('[sniff] req', params.requestId.slice(-6), u.slice(0, 110));
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      const r = this.reqs.get(params.requestId);
      if (r) {
        r.url = params.response.url || r.url;
        r.mime = params.response.mimeType || '';
        r.status = params.response.status || 0;
      }
      return;
    }
    if (method !== 'Network.loadingFinished') return;

    const meta = this.reqs.get(params.requestId);
    if (!meta) {
      if (this.debug) console.log('[sniff] finished-without-meta', params.requestId.slice(-6));
      return;
    }
    this.reqs.delete(params.requestId);
    // 排障用：记录最近若干条非图片请求的状态，方便确认「接口到底有没有回来」
    if (!/\.(png|jpe?g|webp|gif|css|woff2?|ico|svg|js)(\?|$)/i.test(meta.url)) {
      this.log.push({ url: meta.url, status: meta.status, mime: meta.mime });
      if (this.log.length > 200) this.log.shift();
    }

    const interested =
      this.waiters.some((w) => !w.done && this._match(w.matchers, meta.url)) ||
      this.collectors.some((c) => this._match(c.matchers, meta.url));
    if (!interested) {
      if (this.debug && /user_posted/.test(meta.url)) console.log('[sniff] not-interested', meta.url.slice(0, 80));
      return;
    }
    if (meta.status && meta.status >= 400) {
      if (this.debug) console.log('[sniff] status', meta.status, meta.url.slice(0, 80));
      return;
    }

    let text = '';
    // getResponseBody 偶发 "No resource with given identifier found"（响应体还没登记好）。
    // 重试几次比直接丢一条数据划算，丢一条就可能少一整页作品。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        text = res.body || '';
        if (res.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
        if (text) break;
      } catch (e) {
        if (this.debug) console.log('[sniff] body-fail', String(e && e.message).slice(0, 60), meta.url.slice(0, 70));
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!text) {
      if (this.debug) console.log('[sniff] empty-body', meta.url.slice(0, 80));
      return;
    }

    const json = safeJson(text);
    if (!json) {
      if (this.debug) console.log('[sniff] not-json', text.slice(0, 40));
      return;
    }
    if (this.debug && /user_posted/.test(meta.url)) {
      console.log('[sniff] deliver', String(text).slice(0, 60));
    }

    for (const w of this.waiters.slice()) {
      if (w.done || !this._match(w.matchers, meta.url)) continue;
      this._settle(w, { url: meta.url, json });
      return;
    }
    for (const c of this.collectors.slice()) {
      if (!this._match(c.matchers, meta.url)) continue;
      try { c.onJson(json, meta.url); } catch (e) { if (this.onError) this.onError(e); }
    }
  }
}

function safeJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * 从 HTML 里抠出内嵌的初始状态 JSON。
 * 小红书 __INITIAL_STATE__、抖音 _ROUTER_DATA、微博 $render_data 等。
 */
function extractEmbeddedState(html) {
  const src = String(html || '');
  const markers = [
    'window.__INITIAL_STATE__',
    'window.__NUXT__',
    'window._ROUTER_DATA',
    'window.__RENDER_DATA__',
    'window.$render_data',
    '__INITIAL_STATE__',
  ];
  const out = [];
  const seenAt = new Set();
  for (const marker of markers) {
    let idx = src.indexOf(marker);
    while (idx !== -1) {
      const brace = src.indexOf('{', idx);
      if (brace !== -1 && brace - idx < 400 && !seenAt.has(brace)) {
        const obj = readBalancedObject(src, brace);
        if (obj) {
          out.push(obj);
          seenAt.add(brace);
        }
      }
      idx = src.indexOf(marker, idx + marker.length);
      if (out.length > 6) break;
    }
  }
  return out;
}

/**
 * 把页面里「看起来像 JSON、实际是 JS 字面量」的初始状态清洗成能 JSON.parse 的形式。
 *
 * 小红书就是这么写 state 的（实测）：
 *   window.__INITIAL_STATE__={"global":{…},"redmojiTailMap":new Map([]),…}
 * 里面有 new Map/Set/Date、undefined、NaN 这些 JSON 不支持的东西，
 * 直接 parse 一定失败 —— 结果 embeddedState() 一条都取不到，
 * 详情页兜底整条通道全废（实况图因此只剩静图）。
 */
function normalizeJsLiteral(body) {
  return String(body)
    .replace(/\bnew\s+(?:Map|Set|WeakMap|WeakSet)\s*\(\s*\[[^\]]*\]?\s*\)/g, 'null')
    .replace(/\bnew\s+(?:Map|Set|WeakMap|WeakSet)\s*\(\s*\)/g, 'null')
    .replace(/\bnew\s+Date\s*\([^)]*\)/g, 'null')
    .replace(/\bundefined\b/g, 'null')
    .replace(/\bNaN\b/g, 'null')
    .replace(/\bInfinity\b/g, 'null');
}

/** 尾随逗号只在第一次 parse 失败后才动，避免把字符串里的 ", }" 也改坏 */
function stripTrailingCommas(body) {
  return String(body).replace(/,(\s*[}\]])/g, '$1');
}

/** 从 startIndex（指向 '{'）起做括号配对，返回解析后的对象 */
function readBalancedObject(src, startIndex) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = startIndex; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const body = normalizeJsLiteral(src.slice(startIndex, i + 1));
        try { return JSON.parse(body); } catch {}
        try { return JSON.parse(stripTrailingCommas(body)); } catch { return null; }
      }
    }
  }
  return null;
}

module.exports = { Sniffer, extractEmbeddedState, readBalancedObject, safeJson };
