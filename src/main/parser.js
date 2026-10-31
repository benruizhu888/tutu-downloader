'use strict';

const U = require('./platforms/util');
const { harvestMedia, walkJson } = require('./platforms/util');

/** 各平台「登录后才会稳定出现」的 Cookie */
const LOGIN_COOKIE = { xhs: 'web_session', weibo: 'SUB', douyin: 'sessionid' };

/**
 * 各平台的登录浮层选择器。
 *
 * 注意：必须判断「是否真的显示在屏幕上」，不能只用 querySelector 命中即算。
 * 三个平台都是 SPA，登录组件常年挂在 DOM 里（display:none / 尺寸为 0），
 * 早先的实现因此会在用户**已经登录成功**之后仍然判定为未登录，
 * 界面上就会一直提示「请先登录」，用户只能反复登录——这就是那个 bug 的根因。
 */
const LOGIN_UI_SEL = {
  xhs: [
    '.login-container',
    '[class*="login-container"]',
    '.login-box',
    '[class*="loginModal"]',
    '[class*="login-modal"]',
  ],
  weibo: [
    '#pl_login_form',
    '.LoginForm',
    '[class*="loginForm"]',
    '.login-page',
    '.login-layer',
  ],
  douyin: [
    '#login-panel-new',
    '[data-e2e="login-modal"]',
    '.login-mask',
    '[class*="login-modal"]',
  ],
};

/**
 * 主页解析编排：
 * 打开主页 → 挂上接口嗅探 → 自动滚动加载 → 汇总作品 → 按需补详情。
 * 全程只用平台页面的真实请求，不自己造签名。
 */
class ProfileParser {
  constructor(host, adapter) {
    this.host = host;
    this.adapter = adapter;
  }

  async resolveShortUrl(url) {
    if (!/xhslink\.com|t\.cn|v\.douyin\.com/i.test(url)) return url;
    try {
      const res = await this.host.session.fetch(url, { redirect: 'follow', method: 'GET' });
      if (res && res.url) return res.url;
    } catch {}
    return url;
  }

  /**
   * 登录态三态证据：Cookie 是否有、页面上是否真弹着登录层。
   * @returns {Promise<{cookie:boolean, ui:boolean}>}
   */
  async loginState() {
    const id = this.adapter.id;
    const key = LOGIN_COOKIE[id];
    if (!key) return { cookie: false, ui: false };

    let cookie = false;
    try {
      const list = await this.host.session.cookies.get({});
      // 值太短的基本是占位/被清空的 Cookie，不能算登录
      cookie = list.some((c) => c.name === key && String(c.value || '').length > 6);
    } catch {
      return { cookie: false, ui: false };
    }
    if (!cookie) return { cookie: false, ui: false };

    // 小红书游客也会下发 web_session；微博游客也可能带 SUB。
    // 所以有 Cookie 之后再看一眼页面：只有「登录层真的显示着」才算未登录。
    const ui = await this.visibleLoginUi(id);
    return { cookie, ui };
  }

  /**
   * 页面上是否有**可见**的登录浮层。
   * 隐藏的元素（display:none / 尺寸 0 / 视口外 / 祖先透明）一律忽略。
   */
  async visibleLoginUi(id) {
    const sels = LOGIN_UI_SEL[id];
    if (!sels || !sels.length) return false;
    const url = this.host.webContents.getURL();
    if (!url || url === 'about:blank') return false;

    const js = `(() => {
      const sels = ${JSON.stringify(sels)};
      const vw = innerWidth, vh = innerHeight;
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) return false;          // 折叠/占位容器
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          if (Number(cs.opacity) < 0.15) return false;
        }
        return true;
      };
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) if (shown(el)) return true;
      }
      return false;
    })()`;

    try {
      // 页面卡住时 executeJavaScript 可能长时间不返回，超时按「没有登录层」处理
      const r = await this._raceEval(js, 1500);
      return r === true;
    } catch {
      return false;
    }
  }

  async _raceEval(js, ms) {
    let timer = null;
    try {
      return await Promise.race([
        this.host.eval(js),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 是否已登录：有 Cookie，且页面没有正在显示的登录层 */
  async isLoggedIn() {
    const st = await this.loginState();
    return st.cookie && !st.ui;
  }

  /**
   * @param {string} rawUrl 作者主页链接
   * @param {object} opts { onProgress, maxScrolls, shouldStop }
   */
  async parseProfile(rawUrl, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const maxScrolls = opts.maxScrolls || 16;

    let url = String(rawUrl || '').trim();
    const quick = this.adapter.matchUrl(url);
    if (!quick) throw new Error('这个链接不是作者主页链接，请复制作者主页地址后再试');
    if (quick.shortUrl) {
      onProgress({ stage: 'resolve', message: '正在展开短链接…' });
      url = await this.resolveShortUrl(quick.shortUrl);
    }
    const matched = this.adapter.matchUrl(url);
    if (!matched) throw new Error('短链接展开失败，请打开作者主页后从地址栏复制链接');
    const profileUrl = matched.profileUrl || url;

    onProgress({ stage: 'load', message: '正在打开作者主页…' });
    const collected = new Map();
    let author = matched.nickname || '';
    const targetUid = matched.userId || '';
    let domCards = [];
    let landingOk = true;
    let hasMore = null; // 平台接口是否还有下一页（true/false，null = 还没收到）
    // 平台自己说的「总共多少条」和「实际下发多少条」。
    // 微博常见：主页写「全部微博（95）」，接口只下发 70 条，剩 25 条平台根本不给。
    // 这种差异要如实告诉用户，否则永远看着像「少解析了」。
    let listTotal = 0;
    let listRaw = 0;

    // 一条列表响应 → 作品。CDP 嗅探和「页面里包 fetch」两条通道共用。
    const consume = (json, reqUrl) => {
      // 只收「这个作者」的列表。首页/自己的主页也会调同一个 user_posted 接口，
      // 混进来就会出现「左边多出别人的作品、和右边页面完全对不上」。
      if (targetUid) {
        const m = /[?&]user_id=([^&]+)/i.exec(String(reqUrl || ''));
        if (m && m[1] !== targetUid) return;
      }
      let res;
      try { res = this.adapter.parseList(json, { author }); } catch { return; }
      if (!res) return;
      if (res.author && !author) author = res.author;
      if (typeof res.hasMore === 'boolean') hasMore = res.hasMore;
      for (const it of res.items) {
        const old = collected.get(it.id);
        if (!old) { collected.set(it.id, it); continue; }
        // 同一作品可能被多次返回，取媒体更全的那份
        if ((it.assets.length || 0) > (old.assets.length || 0)) collected.set(it.id, it);
      }
    };

    const off = this.host.sniffer.setCollector(this.adapter.listMatchers, consume);

    // 把页面观察器攒下的响应也喂进来（Service Worker 那类请求只能这么读）
    const drainSniff = async () => {
      const rows = await this.host.sniffDrain();
      for (const r of rows) {
        let json = null;
        try { json = JSON.parse(r.body); } catch { continue; }
        consume(json, r.url);
      }
      return rows.length;
    };

    try {
      // 强制重新加载：确保接口真的被重新请求一次（复用旧页面会拿不到数据）
      // 切平台/换页会把上一次导航打断（ERR_ABORTED -3），这不算解析失败
      await this.host.load(profileUrl, { timeout: 35000, force: true }).catch(() => {});
      await sleep(1600);
      await this.host.scrollToTop();

      // 关键校验：页面必须真的停在作者主页上。
      // 小红书有时会把主页链接甩回 /explore 首页，此时下面的 DOM 兜底会把「首页推荐流」
      // 当成作者作品展示（数量、顺序都对得上，但人完全不对），必须在源头拦住。
      // 只对「真的平台域名」做这个校验，离线 E2E 用的是本地测试页，跳过。
      const needsLanding =
        typeof this.adapter.fetchList !== 'function' && /(xiaohongshu|douyin)\.com/i.test(profileUrl);
      if (needsLanding) {
        const landedOk = () => !!this.adapter.matchUrl(this.host.view.webContents.getURL());
        if (!landedOk()) {
          onProgress({ stage: 'load', message: '作者主页被重定向了，正在重新打开…' });
          await this.host.load(profileUrl, { timeout: 30000, force: true }).catch(() => {});
          await sleep(1500);
          await this.host.scrollToTop();
        }
        landingOk = landedOk();
        if (!landingOk) {
          // 不直接报错：接口（user_posted / aweme/post）里拿到的仍然是这个作者的作品，
          // 只是页面被甩走了。这时候只跳过「读页面卡片」这一步，避免把首页推荐混进来。
          onProgress({ stage: 'scroll', message: '页面被重定向了，改用接口数据继续解析…' });
        }
      }

      // 有的平台接口不需要签名（微博 mymblog 只校验 Cookie），
      // 让页面自己去请求并翻页，比「等页面发请求再嗅探」稳定得多。
      let viaDirect = 0;
      if (typeof this.adapter.fetchList === 'function') {
        try {
          const direct = await this.adapter.fetchList(this.host, {
            profileUrl,
            author,
            onProgress,
            shouldStop: opts.shouldStop,
            maxPages: Math.max(2, Math.min(24, maxScrolls + 2)),
          });
          if (direct && direct.items && direct.items.length) {
            if (direct.author && !author) author = direct.author;
            if (Number(direct.total) > 0) listTotal = Number(direct.total);
            if (Number(direct.raw) > 0) listRaw = Number(direct.raw);
            for (const it of direct.items) {
              const old = collected.get(it.id);
              if (!old || (it.assets.length || 0) > (old.assets.length || 0)) collected.set(it.id, it);
            }
            viaDirect = collected.size;
            onProgress({ stage: 'scroll', message: `已加载 ${collected.size} 个作品…`, count: collected.size });
          }
        } catch {
          // 直连失败就退回通用嗅探，不打断整体流程
        }
      }

      onProgress({ stage: 'scroll', message: '正在加载作品列表…', count: collected.size });

      let idle = 0;
      let domCount = 0;
      // 直连已经拿到完整列表时不用再滚页面，省时间也不会因为页面跳转丢数据
      const scrollRounds = viaDirect ? 0 : maxScrolls;
      const deadline = Date.now() + 120000; // 最多滚 2 分钟，防止超大账号卡死
      const scrollLoop = async (rounds) => {
        for (let i = 0; i < rounds; i++) {
          if (opts.shouldStop && opts.shouldStop()) return;
          if (Date.now() > deadline) return;
          const before = collected.size;
          const metrics = await this.host.scrollStep(0.9);
          await sleep(this.adapter.id === 'douyin' ? 1500 : 1200);
          await drainSniff();
          // 每一屏都把已渲染的卡片并进来：小红书是虚拟列表，滚过去的卡片会被移出 DOM，
          // 只在最后合并一次的话，只能看到最后那几张（实测就这么只拿到 30 条）。
          // 但必须先确认页面还停在作者主页：中途被甩回 /explore 时，
          // 那一屏是首页推荐流，并进来就会多出别人的作品（实测多 56 条）。
          const urlNow = this.host.view.webContents.getURL();
          const onRealPlatform = /(xiaohongshu|douyin|weibo)\.(com|cn)/i.test(urlNow);
          const strayed = onRealPlatform && !this.adapter.matchUrl(urlNow);
          const dom = strayed ? null : await this.host.domCards(this.adapter.id).catch(() => null);
          const n = dom && dom.cards ? dom.cards.length : 0;
          if (dom && dom.cards && dom.cards.length) {
            if (!author && dom.author) author = dom.author;
            domCards = dom.cards;
            mergeDomCards(this.adapter, collected, dom.cards, author);
          }
          let grew = collected.size > before;
          if (!grew && n > domCount) { domCount = n; grew = true; }
          onProgress({
            stage: 'scroll',
            message: grew ? `已加载 ${collected.size || domCount} 个作品…` : '正在加载更多…',
            count: collected.size || domCount,
            page: i + 1,
          });
          if (grew) idle = 0;
          else if (++idle >= 3) return; // 连续几屏没新增才认命（网络抖动时别过早放弃）
          // 页面刚打开时 scrollHeight 还很小，很容易误判「已经到底」，至少滚 3 屏再信它。
          // 注意这里不看 hasMore：抓到的可能只是某一页（甚至是最后一页）的局部值，
          // 用它早退会直接把后面的作品截掉。
          if (metrics && metrics.atBottom && !grew && i >= 2) return;
        }
      };

      await drainSniff();
      await scrollLoop(scrollRounds);

      // 兜底 0：一个列表响应都没抓到。小红书首屏是 SSR，经常一次列表请求都不发；
      // 抖音则会被甩到「精选」。重开一次主页再走**完整**一轮滚动——
      // 只补滚两三屏是不够的，那样最多只拿到首屏那 30 条（实测就是这么掉到 30/53 的）。
      if (!collected.size) {
        onProgress({ stage: 'load', message: '接口没返回作品，正在重新打开主页…' });
        await this.host.load(profileUrl, { timeout: 30000, force: true }).catch(() => {});
        await sleep(3200);
        idle = 0;
        domCount = 0;
        await drainSniff();
        await scrollLoop(Math.max(6, scrollRounds));
      }
      await drainSniff();

      // 兜底 1：还是一条都没有，说明可能未登录或页面结构变动
      if (!collected.size) {
        const state = await this.host.embeddedState();
        for (const st of state) {
          const found = harvestFromState(this.adapter, st);
          for (const it of found) if (!collected.has(it.id)) collected.set(it.id, it);
        }
      }

      // 兜底 2（始终执行）：用页面已渲染的卡片补齐 id / 标题 / 封面 / xsec_token。
      // 小红书主页首屏是 SSR，列表接口常常一次都不请求，只能靠 DOM。
      try {
        const dom = landingOk ? await this.host.domCards(this.adapter.id) : { cards: [] };
        if (dom && dom.cards && dom.cards.length) {
          if (!author && dom.author) author = dom.author;
          domCards = dom.cards;
          mergeDomCards(this.adapter, collected, dom.cards, author);
          onProgress({ stage: 'scroll', message: `已加载 ${collected.size} 个作品…`, count: collected.size });
        }
      } catch {}
    } finally {
      off();
    }

    const items = [...collected.values()];
    if (!items.length) {
      // 分清「真没登录」和「登录了但没内容」，否则会把用户推去反复登录
      const st = await this.loginState();
      if (!st.cookie) {
        throw new Error('看起来还没有登录。请先在右侧页面登录，再重新点击「开始解析」');
      }
      if (st.ui) {
        throw new Error('右侧页面还停在登录界面，请先完成登录（扫码或账号密码）再点「开始解析」');
      }
      if (!landingOk) {
        throw new Error(
          '作者主页没打开成功（页面被平台重定向到首页了），接口也没返回作品。请先在右侧手动打开该作者主页，确认能看到作品，再点「开始解析」。'
        );
      }
      throw new Error('没有解析到作品。请确认这是作者主页链接，或该主页的笔记/视频是否公开');
    }
    if (!author) author = items[0].author || '';

    // 顺序以「右侧页面实际排列」为准：先按页面渲染顺序，页面上还没渲染出来的再按时间倒序排在后面。
    // 这样左侧第 1 个就对右侧第 1 个，用户不会觉得两边对不上。
    const domIdx = new Map();
    domCards.forEach((c, i) => {
      if (c && c.id && !domIdx.has(c.id)) domIdx.set(c.id, i);
    });
    const LIMIT = Number.MAX_SAFE_INTEGER;
    items.sort((a, b) => {
      const ia = domIdx.has(a.id) ? domIdx.get(a.id) : LIMIT;
      const ib = domIdx.has(b.id) ? domIdx.get(b.id) : LIMIT;
      if (ia !== ib) return ia - ib;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    // 解析阶段补详情：有些平台的列表接口只给封面（例如小红书的 user_posted
    // 连 image_list 都没有），作品是 Live 实况图还是普通图片，只有详情里分得清。
    // 不补这一步，界面上所有作品都只能标「图片」，实况图也认不出来。
    let liveCount = 0;
    if (typeof this.adapter.prefetchDetails === 'function') {
      onProgress({ stage: 'detail', message: '正在识别 Live 实况图…' });
      try {
        const stat = await this.adapter.prefetchDetails(this.host, items, {
          concurrency: 5,
          onProgress: (p) => {
            liveCount = p.live || 0;
            onProgress({
              stage: 'detail',
              message: `正在识别 Live 图 ${p.done}/${p.total}（已认出 ${p.live} 个实况）`,
              done: p.done,
              total: p.total,
            });
          },
        });
        if (stat && stat.total) liveCount = stat.live || liveCount;
      } catch {
        // 预取失败不影响解析结果，下载前还有一轮兜底
      }
    }

    onProgress({
      stage: 'done',
      message: liveCount
        ? `共解析到 ${items.length} 个作品（其中 ${liveCount} 个 Live 实况图）`
        : `共解析到 ${items.length} 个作品`,
      count: items.length,
    });
    return { items, author, profileUrl, loggedIn: await this.isLoggedIn(), listTotal, listRaw, liveCount };
  }

  /**
   * 补齐缺失媒体的作品（列表接口通常只给封面）。
   * 逐个打开详情页抓数据，失败的作品保留原样并记录原因。
   */
  async resolveDetails(items, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    // all=true：连「已经有图」的作品也去开一次详情——实况图的动态视频只有详情接口里才有，
    // 不打开详情就永远只会下到一张静图（这就是「实况图没转成视频」的根因）。
    // 但解析阶段已经补过详情的（_detailFetched）不用再来一遍：那是几十次网络请求，
    // 重复做一遍下载要慢一大截。
    const list = opts.all
      ? items.filter((it) => {
          if (!it || !it.assets || !it.assets.length) return true;
          if (it._detailFetched) return false;
          return it.type !== 'video';
        })
      : items.filter((it) => this.adapter.needsDetail(it));
    const failed = [];
    let done = 0;
    for (const item of list) {
      if (opts.shouldStop && opts.shouldStop()) break;
      done++;
      onProgress({ stage: 'detail', message: `正在解析作品详情 ${done}/${list.length}`, done, total: list.length, itemId: item.id });
      try {
        const assets = await this._resolveOne(item);
        if (assets.length) {
          item.assets = assets;
          item.type = assets.some((a) => a.kind === 'live') ? 'live' : assets.some((a) => a.kind === 'video') ? 'video' : 'image';
          if (!item.cover) item.cover = assets[0].still || assets[0].url;
          item._liveChecked = true;
        } else {
          failed.push({ id: item.id, reason: '没有找到可下载的媒体' });
        }
      } catch (e) {
        failed.push({ id: item.id, reason: String((e && e.message) || e) });
      }
      await sleep(400 + Math.floor(Math.random() * 400));
    }
    onProgress({ stage: 'detail-done', message: '详情解析完成', failed: failed.length });
    return failed;
  }

  /**
   * 补齐一条作品的媒体。
   *
   * 这里的关键是**不要一有图就收工**：实况图的动态视频往往只在最后一级通道里
   * （小红书在页面初始状态、微博在详情接口），如果 DOM 兜底先拿到了 3 张静图就返回，
   * 视频永远没机会出现 —— 以前就是这个问题，结果实况图全变成静图。
   * 现在改成把各级结果都收集起来，优先取「含视频/实况」的那一组。
   */
  async _resolveOne(item) {
    const groups = [];
    const addGroup = (assets) => {
      if (assets && assets.length) groups.push(assets);
    };
    const hasMotion = (list) => (list || []).some((a) => a && (a.kind === 'live' || a.kind === 'video'));
    const pick = () => {
      if (!groups.length) return [];
      const motion = groups.filter(hasMotion);
      const pool = motion.length ? motion : groups;
      return pool.reduce((a, b) => (b.length > a.length ? b : a));
    };

    // 0) 平台提供了「直接调详情接口」的快通道（微博 /ajax/statuses/show）
    if (typeof this.adapter.fetchDetail === 'function') {
      try {
        const parsed = (await this.adapter.fetchDetail(this.host, item)) || [];
        const hit = parsed.find((p) => p.id === item.id) || parsed[0];
        addGroup(hit && hit.assets);
        if (hasMotion(groups[groups.length - 1] || [])) return pick();
      } catch {}
    }

    const url = this.adapter.detailUrl(item);
    const expectation = this.host.sniffer
      .expect(this.adapter.detailMatchers, 16000)
      .catch(() => null);

    await this.host.load(url, { timeout: 30000, force: true }).catch(() => {});

    // 详情页打不开（笔记被删 / 缺 token / 未登录）就直接放弃，别浪费时间
    // 注意不要用宽泛的 sec_ 匹配：xsec_token / xsec_source 里也含 sec_
    const where = this.host.webContents.getURL();
    if (/\/404(\?|#|$)/.test(where) || /\/404\//.test(where) || /[?&]error_code=\d+/.test(where)) return pick();

    // 页面自己已经渲染出媒体了（小红书是 SSR）就不用干等接口；否则给接口多一点时间
    const dom = await this.host.detailDomMedia();
    const hasDom = dom.images.length > 0 || dom.videos.length > 0;
    const resp = await Promise.race([expectation, sleep(hasDom ? 1200 : 6000).then(() => null)]);

    // 1) 详情接口最准：能给出实况图的「静图 + 视频」配对
    if (resp) {
      const parsed = this.adapter.parseDetail(resp.json) || [];
      const hit = parsed.find((p) => p.id === item.id) || parsed[0];
      addGroup(hit && hit.assets);
    }
    // 2) 内嵌初始状态（小红书笔记页不发接口，数据只在这里）
    const fromState = await this._assetsFromState(item.id);
    addGroup(fromState);
    if (hasMotion(pick())) return pick();
    // 笔记页是「先渲染框架、再塞详情」，刚 load 完读到的 state 可能还是空的。
    // 只在「一点都没读到」时补一次：已经读到图片说明数据到位了，再等也没用。
    if (!fromState.length) {
      await sleep(1200);
      addGroup(await this._assetsFromState(item.id));
      if (hasMotion(pick())) return pick();
    }
    // 3) 页面里已渲染的媒体（画质可能不是原图，但至少能下）
    addGroup(await this._assetsFromDom(dom));
    if (hasMotion(pick())) return pick();
    // 4) 页面脚本数据里扫（视频 / 实况只有这里有播放地址）
    if (typeof this.adapter.mediaFromHtml === 'function') {
      const html = await this.host.pageHtml();
      const found = this.adapter.mediaFromHtml(html);
      const videos = found.videos || [];
      const assets = [];
      if (videos.length) {
        // 注意：HTML 里的图片是整个页面的（推荐流、评论区、侧栏都在里面），
        // 全收会一次下几十张别人的图。静图只用「详情区已经渲染出来的那几张」，
        // 按顺序与视频配对（实况图是第 i 张静图配第 i 段视频）。
        const stills = (dom.images || []).map((u) => U.originalImageUrl(u)).filter(Boolean);
        videos.forEach((v, i) => {
          const still = stills[i] || stills[0] || '';
          assets.push({ kind: still ? 'live' : 'video', url: v, still, ext: 'mp4' });
        });
      } else {
        for (const img of found.images || []) {
          if (!U.isContentImage(img)) continue;
          assets.push({ kind: 'image', url: img, still: img, ext: '' });
        }
      }
      addGroup(assets);
    }
    return pick();
  }

  async _assetsFromState(id) {
    const states = await this.host.embeddedState();
    for (const st of states) {
      const node = findNodeById(st, id);
      if (!node) continue;
      // 平台自己知道 state 里怎么取媒体（小红书实况图的视频在 imageList[].stream 里），
      // 通用 harvestMedia 只会按 URL 猜，猜不出「静图 + 视频」的配对关系
      if (typeof this.adapter.assetsFromState === 'function') {
        const exact = this.adapter.assetsFromState(node, id);
        if (exact && exact.length) return exact;
      }
      const assets = assetsFromNode(this.adapter, node, { id });
      if (assets.length) return assets;
    }
    return [];
  }

  async _assetsFromDom(media) {
    const dom = media || (await this.host.detailDomMedia());
    const images = [];
    const seen = new Set();
    const fallbacks = new Map();
    for (const raw of dom.images) {
      const variant = U.absUrl(raw);
      const u = U.originalImageUrl(raw);
      if (!u || seen.has(u) || !U.isContentImage(u)) continue;
      seen.add(u);
      images.push(u);
      if (variant && variant !== u) fallbacks.set(u, variant);
    }
    const videos = [];
    for (const raw of dom.videos) {
      const u = U.absUrl(raw);
      if (!u || videos.includes(u)) continue;
      videos.push(u);
    }
    if (videos.length) {
      const assets = [];
      videos.forEach((v, i) => {
        const still = images[i] || images[0] || '';
        assets.push({ kind: 'video', url: v, still, ext: 'mp4' });
      });
      for (const img of images.slice(videos.length)) {
        assets.push({ kind: 'image', url: img, still: img, fallback: fallbacks.get(img) || '', ext: '' });
      }
      return assets;
    }
    return images.map((u) => ({ kind: 'image', url: u, still: u, fallback: fallbacks.get(u) || '', ext: '' }));
  }
}

/**
 * 把 DOM 卡片并入结果集。
 * - 已存在：补封面 / 标题 / 带 xsec_token 的详情链接（详情解析离不开 token）
 * - 不存在：新建一条「只有封面」的作品，等下载时再补详情
 */
function mergeDomCards(adapter, collected, cards, author) {
  // 主页滚到底平台会插入「推荐 / 更多」块，那些是**别人**的作品。
  // 卡片自带作者名时按名字过滤掉，否则左侧数量会比主页标称的还多。
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
  const me = norm(author);
  for (const c of cards || []) {
    if (!c || !c.id) continue;
    const who = norm(c.author);
    if (me && who && who !== me) continue;
    const old = collected.get(c.id);
    if (old) {
      if (!old.cover && c.cover) old.cover = c.cover;
      if ((!old.title || /^(笔记|微博|作品)\s+\S+$/.test(old.title)) && c.title) old.title = c.title;
      if (!old.pageUrl && c.href) old.pageUrl = c.href;
      // 小红书页面里有些卡片给的是 /user/profile/<uid>/<noteId> 这种地址，
      // 点开只会回到主页，看起来像「点了没反应」。统一换回 /explore/<id>?xsec_token=…
      if (adapter.id === 'xhs' && (c.token || c.href)) {
        const canonical = adapter.pageUrlFor ? adapter.pageUrlFor(c.id, c.token) : '';
        if (canonical) old.pageUrl = canonical;
      }
      if (c.token && !old._xsecToken) old._xsecToken = c.token;
      if (author && !old.author) old.author = author;
      continue;
    }
    const item = U.makeItem({
      id: c.id,
      platform: adapter.id,
      title: c.title || '',
      desc: c.title || '',
      author: author || '',
      pageUrl: (adapter.pageUrlFor ? adapter.pageUrlFor(c.id, c.token) : '') || c.href || '',
      cover: c.cover || '',
      assets: [],
      type: c.isVideo ? 'video' : 'image',
    });
    item._xsecToken = c.token || '';
    item._fromDom = true;
    collected.set(c.id, item);
  }
}

/** 深度查找 id 匹配的对象节点 */
function findNodeById(root, id) {
  let found = null;
  walkJson(root, (key, value) => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return;
    const cand = value.note_id || value.noteId || value.aweme_id || value.awemeId || value.id || value.idstr || value.mblogid;
    if (cand && String(cand) === String(id)) found = value;
  });
  return found;
}

/** 从任意节点里抽媒体，并按平台语义组装 assets */
function assetsFromNode(adapter, node, item) {
  const { images, videos } = harvestMedia(node);
  const assets = [];
  if (videos.length && images.length) {
    const pairs = Math.min(videos.length, images.length);
    for (let i = 0; i < pairs; i++) assets.push({ kind: 'live', url: videos[i], still: images[i], ext: 'mp4' });
    // 视频比图片少时，多出来的静态图正常保存，不丢内容
    for (let i = pairs; i < images.length; i++) assets.push({ kind: 'image', url: images[i], still: images[i], ext: '' });
    return assets;
  }
  if (videos.length) {
    assets.push({ kind: 'video', url: videos[0], still: images[0] || '', ext: 'mp4' });
    return assets;
  }
  for (const img of images) assets.push({ kind: 'image', url: img, still: img, ext: '' });
  return assets;
}

/** 无接口命中时，从页面初始状态里兜底扫作品 */
function harvestFromState(adapter, state) {
  const out = [];
  walkJson(state, (key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    try {
      if (adapter.id === 'xhs') {
        const it = adapter.normalizeNote(value, {});
        if (it && it.assets.length) out.push(it);
      } else if (adapter.id === 'douyin') {
        if (value.aweme_id && (value.video || value.images)) {
          const it = adapter.normalizeAweme(value, {});
          if (it && it.assets.length) out.push(it);
        }
      } else if (adapter.id === 'weibo') {
        const it = adapter.normalizeStatus(value, {});
        if (it && it.assets.length) out.push(it);
      }
    } catch {}
  });
  const seen = new Set();
  return out.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { ProfileParser, findNodeById, assetsFromNode, harvestFromState, mergeDomCards, sleep };
