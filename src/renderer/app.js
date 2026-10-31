'use strict';

/* ============================================================
 * 兔兔下载器 · 渲染层
 * 状态全部留在前端，主进程只做「页面操作 + 下载 + 转换」
 * ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  platformId: 'xhs',
  platforms: [],
  info: null,
  byPlatform: {}, // platformId -> { items, selected:Set, url, author, tasks:Map, failed:[] }
  tab: 'works',
  filter: 'all',
  parsing: false,
  downloading: false,
  viewVisible: true,
};

const TYPE_TEXT = { image: '图片', video: '视频', live: '实况' };
const TYPE_CLASS = { image: 'b-image', video: 'b-video', live: 'b-live' };

function pstate(id = state.platformId) {
  if (!state.byPlatform[id]) {
    state.byPlatform[id] = { items: [], selected: new Set(), url: '', author: '', tasks: new Map(), failed: [], order: [], liveCount: 0 };
  }
  return state.byPlatform[id];
}

/**
 * 「主页标称 95 条、接口只下发 70 条」这种差异要说清楚。
 * 平台把一部分内容（仅自己可见 / 已删除 / 不下发的）也算在标称数字里，客户端拿不到；
 * 不解释的话，用户只会觉得「少解析了」。
 */
function countNote(st) {
  const total = Number(st.listTotal) || 0;
  const raw = Number(st.listRaw) || 0;
  if (!total || total <= st.items.length) return '';
  const parts = [`主页标称 ${total} 条`];
  if (raw) parts.push(`平台只下发 ${raw} 条`);
  const skipped = raw ? raw - st.items.length : 0;
  if (skipped > 0) parts.push(`其中 ${skipped} 条无图无视频已跳过`);
  return `（${parts.join('，')}）`;
}

/**
 * Live 实况图的数量提示。
 * 小红书的列表接口里没有这些信息，是解析阶段逐条取详情才认出来的，
 * 所以要在标题和完成提示里写清楚「其中几个是实况图」。
 */
function liveNote(st) {
  const n = Number(st.liveCount) || 0;
  return n > 0 ? `（含 ${n} 个 Live 实况图）` : '';
}

/* ---------------- 基础 UI ---------------- */

function toast(message, kind = 'info', timeout = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const icon = kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i';
  el.innerHTML = `<span class="t-ico">${icon}</span><span></span>`;
  el.lastElementChild.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, timeout);
}

function setStatus(text, kind = 'run') {
  const bar = $('#statusBar');
  if (!text) {
    bar.classList.add('hidden');
    $('#statusText').textContent = '';
    return;
  }
  bar.classList.remove('hidden', 'ok', 'err');
  if (kind === 'ok') bar.classList.add('ok');
  if (kind === 'err') bar.classList.add('err');
  $('#statusText').textContent = text;
}

function setStep(n) {
  $$('.step').forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle('on', i === n);
    el.classList.toggle('done', i < n);
  });
}

function maskPath(p) {
  if (!p) return '—';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

/* ---------------- 初始化 ---------------- */

async function boot() {
  state.info = await window.tutu.info();
  state.platforms = state.info.platforms;
  state.downloadDir = state.info.downloadDir;

  $('#dirPath').textContent = maskPath(state.downloadDir);
  $('#dirPath').title = state.downloadDir;
  $('#ffNote').textContent = state.info.ffmpeg
    ? '实况图导出：原始码流直取 / 无损封装'
    : '未检测到 ffmpeg：实况图将保留原始视频文件';

  const brand = $('#brandImg');
  brand.src = '../../build/icon.png';
  brand.onerror = () => brand.setAttribute('data-fail', '1');

  renderNav();
  bindEvents();
  syncMaxState();
  await selectPlatform(state.platforms[0].id, true);
  setStep(1);
  syncSettingsUI();
  requestAnimationFrame(syncBounds);
}

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const p of state.platforms) {
    const st = state.byPlatform[p.id];
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (p.id === state.platformId ? ' on' : '');
    btn.dataset.pid = p.id;
    const count = st && st.items.length ? `${st.items.length} 个作品` : '等待解析';
    btn.innerHTML = `
      <span class="nav-badge" style="background:${p.accent}">${p.name.slice(0, 1)}</span>
      <span class="nav-meta">
        <span class="nav-name">${p.name}</span>
        <span class="nav-count" data-count="${p.id}">${count}</span>
      </span>
      <span class="nav-kbd">›</span>`;
    btn.addEventListener('click', () => selectPlatform(p.id));
    nav.appendChild(btn);
  }
}

function updateNavCount(id = state.platformId) {
  const el = document.querySelector(`[data-count="${id}"]`);
  const st = state.byPlatform[id];
  if (el) el.textContent = st && st.items.length ? `${st.items.length} 个作品` : '等待解析';
}

async function selectPlatform(id, first = false) {
  if (!state.platforms.length) return;
  state.platformId = id;
  const p = state.platforms.find((x) => x.id === id);
  $$('.nav-item').forEach((el) => el.classList.toggle('on', el.dataset.pid === id));

  $('#pgTitle').textContent = p.name;
  const placeholders = {
    xhs: 'https://www.xiaohongshu.com/user/profile/…',
    weibo: 'https://weibo.com/u/1234567890',
    douyin: 'https://www.douyin.com/user/MS4wLjAB…',
  };
  $('#urlInput').placeholder = `粘贴${p.name}作者的主页链接，例如 ${placeholders[id] || ''}`;
  $('#urlInput').value = pstate(id).url || '';
  $('#fieldWrap').classList.toggle('has-value', !!$('#urlInput').value);
  $('#bpTitle').textContent = `${p.name} · 登录 / 浏览`;
  // 切平台时副标题/状态条要跟着换成该平台自己的进度，别把上一个平台的「共 N 个作品」留在这儿
  const st0 = pstate(id);
  $('#pgSub').textContent = st0.items.length
    ? `${st0.author ? st0.author + ' · ' : ''}共 ${st0.items.length} 个作品${countNote(st0)}`
    : '粘贴作者主页链接 → 勾选作品 → 点击下载';
  setStatus(st0.items.length ? `解析完成，共 ${st0.items.length} 个作品${countNote(st0)}` : '');
  setStep(st0.items.length ? 2 : 1);
  $('#workGrid').innerHTML = '';
  $('#taskList').innerHTML = '';
  clearPreview();
  renderAll();

  const res = await window.tutu.selectPlatform(id);
  setLoginChip(res && res.loggedIn !== undefined && res.loggedIn !== null ? !!res.loggedIn : null);
  if (!pstate(id).url && res && res.lastUrl) {
    $('#urlInput').value = res.lastUrl;
    pstate(id).url = res.lastUrl;
    $('#fieldWrap').classList.add('has-value');
  }
  state.viewVisible = true;
  requestAnimationFrame(() => {
    syncBounds();
    renderAll();
  });
  if (!first) window.tutu.showView();
}

function setLoginChip(loggedIn) {
  const chip = $('#loginChip');
  const pending = loggedIn === null || loggedIn === undefined;
  chip.classList.toggle('ok', loggedIn === true);
  chip.classList.toggle('warn', loggedIn === false);
  if (pending) {
    chip.lastElementChild.textContent = '检测登录状态…';
    return;
  }
  chip.lastElementChild.textContent = loggedIn ? '已登录' : '未登录 · 请在右侧登录';
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $$('.wc').forEach((b) => b.addEventListener('click', async () => {
    await window.tutu.windowControl(b.dataset.win);
    if (b.dataset.win === 'maximize') setTimeout(syncMaxState, 80);
  }));
  document.querySelector('.titlebar').addEventListener('dblclick', async (e) => {
    if (e.target.closest('button')) return;
    await window.tutu.windowControl('maximize');
    setTimeout(syncMaxState, 80);
  });
  window.addEventListener('resize', syncMaxState);

  $('#btnOpenDir').addEventListener('click', () => window.tutu.openPath(state.downloadDir));
  $('#dirCard').addEventListener('click', () => window.tutu.openPath(state.downloadDir));

  $('#btnSettings').addEventListener('click', () => {
    $('#settingsSheet').classList.remove('hidden');
    syncSettingsUI();
  });
  $('#sheetClose').addEventListener('click', () => $('#settingsSheet').classList.add('hidden'));

  $('#btnPaste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $('#urlInput').value = text.trim();
        $('#fieldWrap').classList.add('has-value');
        $('#urlInput').focus();
      }
    } catch {
      toast('无法读取剪贴板，请手动粘贴链接', 'err');
    }
  });

  $('#btnClear').addEventListener('click', () => {
    $('#urlInput').value = '';
    $('#fieldWrap').classList.remove('has-value');
  });

  $('#urlInput').addEventListener('input', (e) => {
    $('#fieldWrap').classList.toggle('has-value', !!e.target.value.trim());
    pstate().url = e.target.value.trim();
  });

  $('#urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startParse();
  });

  $('#btnParse').addEventListener('click', startParse);
  $('#btnStop').addEventListener('click', async () => {
    await window.tutu.stopParse(state.platformId);
    setStatus('正在停止…', 'run');
  });

  $('#btnSelectAll').addEventListener('click', toggleSelectAll);
  $('#filterType').addEventListener('change', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('#seg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    $$('.seg-btn').forEach((b) => b.classList.toggle('on', b === btn));
    renderAll();
    syncBounds();
  });

  $('#btnDownload').addEventListener('click', startDownload);
  $('#btnRetryFailed').addEventListener('click', retryFailed);

  $('#btnHome').addEventListener('click', () => { clearPreview(); window.tutu.goHome(state.platformId); });
  $('#btnReload').addEventListener('click', () => { clearPreview(); window.tutu.reloadPage(state.platformId); });

  // 网页面板右侧按钮：全屏预览（Esc 退出）
  $('#btnViewFull').addEventListener('click', () => toggleViewOnly());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('.workarea').classList.contains('view-only')) toggleViewOnly(false);
  });

  $('#setDir').addEventListener('click', async () => {
    const dir = await window.tutu.pickDir();
    if (dir) {
      state.downloadDir = dir;
      $('#dirPath').textContent = maskPath(dir);
      $('#dirPath').title = dir;
      syncSettingsUI();
      toast('保存位置已更新', 'ok');
    }
  });

  $('#setConcurrency').addEventListener('input', async (e) => {
    $('#concurrencyVal').textContent = e.target.value;
    await window.tutu.setSettings({ concurrency: Number(e.target.value) });
  });

  $('#setScrolls').addEventListener('input', async (e) => {
    $('#scrollsVal').textContent = e.target.value;
    await window.tutu.setSettings({ maxScrolls: Number(e.target.value) });
  });

  $('#setDetectLive').addEventListener('change', async (e) => {
    state.info = { ...(state.info || {}), detectLive: !!e.target.checked };
    await window.tutu.setSettings({ detectLive: !!e.target.checked });
    toast(
      e.target.checked
        ? '实况图会导出为 MP4 视频（不转码，画质与原片一致）'
        : '已关闭实况视频导出：实况图只保存静态图片',
      'info',
      3200
    );
  });

  // 点一下标签就现场复核一次：页内登录后即使事件没送到，用户也能手动刷新，
  // 不用靠「切换平台」来碰运气
  $('#loginChip').addEventListener('click', async () => {
    setLoginChip(null);
    try {
      const res = await window.tutu.loginState(state.platformId);
      const ok = !!(res && res.loggedIn);
      setLoginChip(ok);
      if (ok) toast('已登录，登录状态会自动保存', 'ok', 2600);
      else if (res && res.loginUi) toast('右侧页面正在显示登录框，扫码或账号登录后会自动更新', 'info', 3400);
      else toast('还没有登录。请在右侧页面点击登录 / 扫码', 'info', 3400);
    } catch {
      setLoginChip(false);
      toast('检查登录状态失败，可在右侧页面刷新后重试', 'err', 3200);
    }
  });

  window.addEventListener('resize', syncBounds);
  $('#panelBody').addEventListener('scroll', syncBounds, { passive: true });
  new ResizeObserver(() => syncBounds()).observe($('#browserSlot'));

  window.tutu.on('parse:progress', onParseProgress);
  window.tutu.on('detail:progress', onDetailProgress);
  window.tutu.on('download:event', onDownloadEvent);
  window.tutu.on('platform:ready', (p) => {
    if (p && p.platformId === state.platformId) setLoginChip(!!p.loggedIn);
  });

  // 内嵌页面里点了「一键解析」：切到对应平台、填好链接、直接开跑
  window.tutu.on('view:parse-request', async (p) => {
    if (!p || !p.platformId) return;
    if (!p.valid) {
      toast('请先在右侧页面打开作者主页，再点「一键解析」', 'err');
      return;
    }
    if (state.parsing) {
      toast('正在解析中，请稍等…', 'info');
      return;
    }
    if (state.platformId !== p.platformId) await selectPlatform(p.platformId, true);
    $('#urlInput').value = p.url;
    startParse();
  });
}

function syncSettingsUI() {
  const info = state.info || {};
  $('#setDir').textContent = maskPath(state.downloadDir);
  $('#setDir').title = state.downloadDir || '';
  $('#setConcurrency').value = info.concurrency || 3;
  $('#concurrencyVal').textContent = info.concurrency || 3;
  const scrolls = info.maxScrolls || 40;
  $('#setScrolls').value = scrolls;
  $('#scrollsVal').textContent = scrolls;
  $('#setDetectLive').checked = info.detectLive !== false;
}

/* ---------------- 窗口最大化状态 ---------------- */

async function syncMaxState() {
  try {
    const maxed = await window.tutu.isMaximized();
    document.querySelector('.window').classList.toggle('is-maxed', !!maxed);
    $('.wc-max').title = maxed ? '还原' : '全屏';
  } catch {}
}

/* ---------------- 内嵌页面位置同步 ---------------- */
let boundsRaf = 0;
function syncBounds() {
  if (boundsRaf) return;
  boundsRaf = requestAnimationFrame(() => {
    boundsRaf = 0;
    const slot = $('#browserSlot');
    const r = slot.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    window.tutu.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  });
}

/* ---------------- 网页面板右侧按钮：全屏预览 ---------------- */
function toggleViewOnly(force) {
  const wa = $('.workarea');
  const on = force === undefined ? !wa.classList.contains('view-only') : !!force;
  wa.classList.toggle('view-only', on);
  const btn = $('#btnViewFull');
  btn.classList.toggle('on', on);
  btn.title = on ? '退出全屏预览（Esc）' : '全屏预览（Esc 退出）';
  syncBounds();
}

/* ---------------- 解析 ---------------- */

function detectPlatform(url) {
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return 'xhs';
  if (/weibo\.(com|cn)/i.test(url)) return 'weibo';
  if (/douyin\.com/i.test(url)) return 'douyin';
  return null;
}

async function startParse() {
  if (state.parsing) return;
  clearPreview();
  const url = $('#urlInput').value.trim();
  if (!url) {
    toast('先把作者主页链接粘贴到上面的输入框', 'err');
    $('#urlInput').focus();
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    toast('链接要以 http:// 或 https:// 开头', 'err');
    return;
  }
  const detected = detectPlatform(url);
  if (detected && detected !== state.platformId) {
    await selectPlatform(detected);
    $('#urlInput').value = url;
    $('#fieldWrap').classList.add('has-value');
  }
  if (!detected) {
    toast('无法识别平台，请确认是小红书 / 微博 / 抖音的主页链接', 'err', 3600);
    return;
  }

  state.parsing = true;
  setStep(1);
  $('#btnParse').disabled = true;
  $('#parseSpinner').classList.remove('hidden');
  $('#btnParse').querySelector('.btn-label').textContent = '解析中';
  $('#btnStop').classList.remove('hidden');
  setStatus('正在打开作者主页…', 'run');

  const st = pstate();
  st.items = [];
  st.selected.clear();
  renderAll();

  try {
    const res = await window.tutu.parse(state.platformId, url);
    if (!res || !res.ok) {
      setStatus('');
      toast((res && res.error) || '解析失败，请稍后重试', 'err', 4200);
      return;
    }
    const seen = new Set();
    st.items = (res.items || []).filter((it) => {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
    st.author = res.author || '';
    st.url = url;
    st.failed = [];
    st.listTotal = Number(res.listTotal) || 0;
    st.listRaw = Number(res.listRaw) || 0;
    // 解析阶段就识别出来的 Live 实况图数量（小红书的列表接口里没有这些信息，
    // 是靠逐条取详情补出来的）
    st.liveCount = Number(res.liveCount) || 0;
    $('#pgSub').textContent = st.author
      ? `${st.author} · 共 ${st.items.length} 个作品${countNote(st)}${liveNote(st)}`
      : `共 ${st.items.length} 个作品${countNote(st)}${liveNote(st)}`;
    setLoginChip(!!res.loggedIn);
    hideSlotHint();
    setStatus(`解析完成，共 ${st.items.length} 个作品${countNote(st)}${liveNote(st)}`, 'ok');
    setStep(2);
    toast(`解析到 ${st.items.length} 个作品${liveNote(st)}，勾选后即可下载`, 'ok', 3800);
    updateNavCount();
    renderAll();
  } catch (e) {
    setStatus('');
    toast('解析出错：' + ((e && e.message) || e), 'err', 4200);
  } finally {
    state.parsing = false;
    $('#btnParse').disabled = false;
    $('#parseSpinner').classList.add('hidden');
    $('#btnParse').querySelector('.btn-label').textContent = '开始解析';
    $('#btnStop').classList.add('hidden');
  }
}

function hideSlotHint() {
  const hint = document.querySelector('.slot-hint');
  if (hint) hint.style.display = 'none';
}

function onParseProgress(p) {
  if (!p || p.platformId !== state.platformId) return;
  if (p.stage === 'error') {
    setStatus('');
    return;
  }
  if (p.message) setStatus(p.message, p.stage === 'done' ? 'ok' : 'run');
  if (p.stage === 'scroll' && p.count) {
    const st = pstate();
    if (st.items.length < p.count) {
      // 数量提示（真实数据在解析结束后一次性给出）
      updateNavCount();
    }
  }
}

function onDetailProgress(p) {
  if (!p || p.platformId !== state.platformId) return;
  if (p.message) setStatus(p.message, 'run');
}

/* ---------------- 作品列表 ---------------- */

function visibleItems() {
  const st = pstate();
  if (state.filter === 'all') return st.items;
  return st.items.filter((it) => it.type === state.filter);
}

function renderAll() {
  renderGrid();
  renderTasks();
  renderFoot();
  $('#worksTools').classList.toggle('hidden', state.tab !== 'works');
  $('#panelFoot').classList.toggle('hidden', state.tab !== 'works');
  $('#taskList').classList.toggle('hidden', state.tab !== 'tasks');
  $('#workGrid').classList.toggle('hidden', state.tab !== 'works');
  const empty = $('#emptyState');
  empty.classList.toggle('hidden', state.tab !== 'works' || visibleItems().length > 0);
  if (state.tab === 'works' && pstate().items.length && !visibleItems().length) {
    empty.querySelector('.empty-title').textContent = '这个类型下没有作品';
    empty.querySelector('.empty-desc').textContent = '换个筛选条件，或在「全部类型」里看全部作品';
  } else {
    empty.querySelector('.empty-title').textContent = '还没有作品';
    empty.querySelector('.empty-desc').textContent = '复制博主主页链接粘贴到上方，点「开始解析」';
  }
}

function renderGrid() {
  const grid = $('#workGrid');
  const st = pstate();
  const items = visibleItems();
  grid.innerHTML = '';
  if (state.tab !== 'works') return;

  const frag = document.createDocumentFragment();
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card'
      + (st.selected.has(it.id) ? ' selected' : '')
      + (previewId === it.id ? ' previewing' : '');
    card.dataset.id = it.id;
    card.dataset.url = it.pageUrl || '';
    const badge = TYPE_TEXT[it.type] || '作品';
    const assetCount = (it.assets && it.assets.length) || 0;
    card.innerHTML = `
      <div class="card-cover">
        <div class="ph">🐰</div>
        <img loading="lazy" alt="" />
        <span class="card-badge ${TYPE_CLASS[it.type] || 'b-image'}">${badge}</span>
        ${assetCount > 1 ? `<span class="card-count">${assetCount}</span>` : ''}
        <span class="check"><svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 6.3 4.7 9 10 3.4" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </div>
      <div class="card-meta"><div class="card-title"></div></div>`;

    const img = card.querySelector('img');
    if (it.cover) {
      img.src = it.cover;
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => { img.remove(); }, { once: true });
    } else {
      img.remove();
    }
    card.querySelector('.card-title').textContent = it.title || '未命名作品';
    card.title = [
      it.title || '',
      `类型：${badge}${assetCount > 1 ? ` · ${assetCount} 个文件` : ''}`,
      '点卡片：在右侧打开这条作品',
      '点右上角圆圈：选中 / 取消',
    ].join('\n') + (it.assets && it.assets.length ? '' : '\n（下载时会自动解析详情）');
    // 点卡片右上角的圆圈 = 勾选；点卡片其它地方 = 在右侧预览这条作品
    card.addEventListener('click', (e) => {
      if (e.target.closest('.check')) {
        toggleSelect(it.id);
        return;
      }
      previewItem(it);
    });
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

/* ---------------- 点击作品 → 右侧预览 ---------------- */
let previewId = '';

async function previewItem(it) {
  if (!it) return;
  // 解析会滚动并抓取当前页面，此时跳走会打断解析
  if (state.parsing) {
    toast('正在解析中，等解析完成再点作品预览', 'info');
    return;
  }
  const url = it.pageUrl || '';
  if (!url) {
    toast('这条作品缺少可打开的链接，重新解析一次即可预览', 'err');
    return;
  }
  const res = await window.tutu.previewItem(state.platformId, url, it.id);
  const ok = !!(res && res.ok);
  if (!ok && !(res && res.url)) {
    toast('预览没能打开，可以点右上角「回到首页」再试', 'err');
    return;
  }
  previewId = it.id;
  $$('#workGrid .card').forEach((c) => c.classList.toggle('previewing', c.dataset.id === it.id));
  const t = $('#bpTitle');
  if (t) {
    // 标题不截字符，交给 CSS 省略号，鼠标悬停还能看全文
    t.textContent = '预览：' + String(it.title || '作品');
    t.title = String(it.title || '作品');
  }
  syncBounds();
}

function clearPreview() {
  previewId = '';
  $$('#workGrid .card').forEach((c) => c.classList.remove('previewing'));
  const t = $('#bpTitle');
  if (t) {
    const p = state.platforms.find((x) => x.id === state.platformId);
    t.textContent = p ? `${p.name} · 登录 / 浏览` : '登录 / 浏览';
    t.removeAttribute('title');
  }
}

function toggleSelect(id) {
  const st = pstate();
  if (st.selected.has(id)) st.selected.delete(id);
  else st.selected.add(id);
  const card = $(`.card[data-id="${cssEscape(id)}"]`);
  if (card) card.classList.toggle('selected', st.selected.has(id));
  renderFoot();
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function toggleSelectAll() {
  const st = pstate();
  const items = visibleItems();
  const allSelected = items.length > 0 && items.every((it) => st.selected.has(it.id));
  if (allSelected) items.forEach((it) => st.selected.delete(it.id));
  else items.forEach((it) => st.selected.add(it.id));
  renderGrid();
  renderFoot();
}

function renderFoot() {
  const st = pstate();
  const n = st.selected.size;
  $('#selInfo').innerHTML = n
    ? `已选 <b>${n}</b> 个作品`
    : `已选 0 个作品 · 共 ${st.items.length} 个`;
  $('#btnDownload').disabled = n === 0 || state.downloading;
  $('#btnDownload').textContent = state.downloading ? '下载中…' : n ? `下载选中（${n}）` : '下载选中';
  $('#btnSelectAll').textContent =
    visibleItems().length && visibleItems().every((it) => st.selected.has(it.id)) ? '取消全选' : '全选';
  $('#btnRetryFailed').classList.toggle('hidden', !(st.failed && st.failed.length) || state.downloading);
  const badge = $('#taskBadge');
  const pending = st.tasks.size;
  badge.classList.toggle('hidden', !pending);
  badge.textContent = pending > 99 ? '99+' : String(pending);
}

/* ---------------- 下载 ---------------- */

async function startDownload() {
  const st = pstate();
  const selected = st.items.filter((it) => st.selected.has(it.id));
  if (!selected.length || state.downloading) return;

  state.downloading = true;
  setStep(3);
  renderFoot();
  syncBounds();

  try {
    const missing = selected.filter((it) => !it.assets || !it.assets.length);
    // 实况图（live photo）的动态视频只在作品详情里，列表里通常只有静图。
    // 所以「已经带图」的作品也要开一次详情，否则永远只会下到一张图片、转不出视频。
    // 解析阶段已经补过详目的（_detailFetched）不用再来一遍。
    // 注意：这一步跟「实况图导出为 MP4」开关无关 —— 认不认得出实况是解析的事，
    // 导不导出才是设置的事（关掉时实况只下静图那一半）。
    const needLive = selected.filter(
      (it) => it.assets && it.assets.length && it.type !== 'video' && !it._detailFetched
    );
    const todo = [...missing, ...needLive];
    if (todo.length) {
      setStatus(
        missing.length
          ? `正在解析 ${todo.length} 个作品详情…`
          : `正在检查 ${todo.length} 个作品有没有实况素材…`,
        'run'
      );
      const res = await window.tutu.resolveDetails(state.platformId, todo, { all: true });
      if (res && res.items) {
        // 详情解析会就地更新对象，这里同步回列表
        for (const updated of res.items) {
          const idx = st.items.findIndex((x) => x.id === updated.id);
          if (idx >= 0) st.items[idx] = updated;
        }
        renderGrid();
      }
      if (res && res.failed && res.failed.length) {
        toast(`${res.failed.length} 个作品没解析到媒体，已跳过`, 'err', 3800);
      }
    }

    const ready = selected.filter((it) => it.assets && it.assets.length);
    if (!ready.length) {
      setStatus('');
      toast('选中的作品都没有可下载的媒体', 'err', 3800);
      return;
    }

    st.failed = [];
    st.tasks.clear();
    state.tab = 'tasks';
    $$('.seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'tasks'));
    renderAll();
    syncBounds();

    setStatus(`开始下载 ${ready.length} 个作品…`, 'run');
    const res = await window.tutu.download(state.platformId, ready, state.downloadDir);
    setStatus('');
    if (res && res.ok) {
      const msg = `完成：成功 ${res.success} 个${res.failed ? `，失败 ${res.failed} 个` : ''}${res.canceled ? `，取消 ${res.canceled} 个` : ''}`;
      toast(msg, res.failed ? 'err' : 'ok', 4200);
      if (res.failed || res.canceled) {
        st.failed = collectFailed();
      }
      // 下载完不再自动弹出下载目录（用户要求），只保留完成提示；
      // 需要看文件时自己去保存目录里取，或点界面上的「打开目录」。
    }
  } catch (e) {
    toast('下载出错：' + ((e && e.message) || e), 'err', 4200);
  } finally {
    state.downloading = false;
    renderFoot();
    renderAll();
  }
}

function collectFailed() {
  const st = pstate();
  const out = [];
  for (const [id, t] of st.tasks) {
    if (t.status === 'failed' || t.status === 'canceled') {
      const item = st.items.find((x) => x.id === id);
      if (item) out.push(item);
    }
  }
  return out;
}

async function retryFailed() {
  const st = pstate();
  const items = (st.failed || []).slice();
  if (!items.length || state.downloading) return;
  st.failed = [];
  renderFoot();
  state.downloading = true;
  // 只重跑失败项：沿用现有任务卡片
  try {
    setStatus(`正在重试 ${items.length} 个作品…`, 'run');
    const res = await window.tutu.download(state.platformId, items, state.downloadDir);
    setStatus('');
    if (res && res.ok) {
      toast(`重试完成：成功 ${res.success} 个${res.failed ? `，仍失败 ${res.failed} 个` : ''}`, res.failed ? 'err' : 'ok', 4000);
      st.failed = collectFailed();
    }
  } finally {
    state.downloading = false;
    renderFoot();
    renderAll();
  }
}

function taskEl(id) {
  const st = pstate();
  let t = st.tasks.get(id);
  if (t && t.el && document.body.contains(t.el)) return t;
  return t;
}

function ensureTaskCard(data) {
  const st = pstate();
  let t = st.tasks.get(data.id);
  if (!t) {
    t = { id: data.id, el: document.createElement('div'), status: 'wait', percent: 0, dir: '', error: '', title: data.title || '' };
    t.el.className = 'task';
    t.el.innerHTML = `
      <div class="task-top">
        <span class="task-ico wait">…</span>
        <span class="task-title"></span>
        <span class="task-pct">等待中</span>
      </div>
      <div class="task-bar"><i></i></div>
      <div class="task-sub"></div>`;
    st.tasks.set(data.id, t);
    $('#taskList').appendChild(t.el);
  }
  return t;
}

function onDownloadEvent(ev) {
  if (!ev || ev.platformId !== state.platformId) return;
  const st = pstate();

  if (ev.type === 'summary') {
    if (ev.phase === 'done') {
      // 完成提示只在这里出一次（startDownload 里不再重复设置，避免两处文案打架）
      const parts = [`成功 ${ev.success} 个`];
      if (ev.failed) parts.push(`失败 ${ev.failed} 个`);
      if (ev.canceled) parts.push(`取消 ${ev.canceled} 个`);
      setStatus(`下载完成：${parts.join('，')}`, ev.failed ? 'err' : 'ok');
      setTimeout(() => setStatus(''), 4000);
    }
    return;
  }

  if (ev.type === 'item-start') {
    const t = ensureTaskCard(ev);
    t.status = 'run';
    t.dir = ev.dir;
    t.title = ev.title || t.title;
    t.el.querySelector('.task-title').textContent = t.title || ev.id;
    t.el.querySelector('.task-ico').className = 'task-ico run';
    t.el.querySelector('.task-ico').textContent = '↓';
    t.el.querySelector('.task-pct').textContent = '0%';
    t.el.querySelector('.task-sub').textContent = `${ev.assetCount || 0} 个文件`;
    renderFoot();
    return;
  }

  if (ev.type === 'item-progress') {
    const t = st.tasks.get(ev.id);
    if (!t) return;
    t.percent = ev.percent || 0;
    t.el.querySelector('.task-bar i').style.width = `${t.percent}%`;
    t.el.querySelector('.task-pct').textContent = `${t.percent}%`;
    if (ev.bytes) {
      const mb = (ev.bytes / 1048576).toFixed(1);
      const total = ev.bytesTotal ? ` / ${(ev.bytesTotal / 1048576).toFixed(1)} MB` : ' MB';
      t.el.querySelector('.task-sub').textContent =
        `文件 ${ev.assetIndex + 1}/${ev.assetCount} · ${mb}${total}`;
    }
    return;
  }

  if (ev.type === 'item-done') {
    const t = st.tasks.get(ev.id) || ensureTaskCard(ev);
    const ico = t.el.querySelector('.task-ico');
    const pct = t.el.querySelector('.task-pct');
    const sub = t.el.querySelector('.task-sub');
    const bar = t.el.querySelector('.task-bar i');
    t.status = ev.status;
    if (ev.status === 'success') {
      ico.className = 'task-ico ok';
      ico.textContent = '✓';
      pct.textContent = '完成';
      bar.style.width = '100%';
      sub.innerHTML = '';
      const n = (ev.files || []).length;
      const text = document.createElement('span');
      text.textContent = `${n} 个文件已保存${ev.notes ? ' · ' + ev.notes : ''}`;
      sub.appendChild(text);
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = '打开';
      btn.style.height = '18px';
      btn.style.padding = '0 6px';
      btn.style.fontSize = '10px';
      btn.addEventListener('click', () => window.tutu.openPath(ev.dir));
      sub.appendChild(btn);
    } else if (ev.status === 'canceled') {
      ico.className = 'task-ico wait';
      ico.textContent = '–';
      pct.textContent = '已取消';
      bar.style.width = '0%';
      sub.textContent = '已取消';
    } else {
      ico.className = 'task-ico err';
      ico.textContent = '!';
      pct.textContent = '失败';
      bar.style.width = '100%';
      sub.innerHTML = `<span class="err-text">${escapeHtml(ev.error || '下载失败')}</span>`;
    }
    renderFoot();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTasks() {
  const st = pstate();
  if (state.tab !== 'tasks') return;
  if (!st.tasks.size) {
    $('#taskList').innerHTML = `<div class="empty"><div class="empty-art">📥</div><div class="empty-title">还没有下载任务</div><div class="empty-desc">回到「作品」标签，勾选后点「下载选中」</div></div>`;
    return;
  }
  const holder = document.createElement('div');
  holder.className = 'tasks';
  for (const t of st.tasks.values()) holder.appendChild(t.el);
  const old = $('#taskList').querySelector('.tasks');
  if (old) old.replaceWith(holder);
  else {
    $('#taskList').innerHTML = '';
    $('#taskList').appendChild(holder);
  }
}

/* 全局快捷键 */
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && document.activeElement === $('#urlInput')) {
    // 交给默认粘贴
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') startParse();
});

boot().catch((e) => {
  console.error(e);
  toast('界面初始化失败：' + ((e && e.message) || e), 'err', 6000);
});
