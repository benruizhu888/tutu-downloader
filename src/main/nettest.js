'use strict';

/**
 * 真实网络自检（--net-test）。
 *
 * 用法：
 *   electron . --net-test=https://www.douyin.com/user/xxxx
 *   electron . --net-test=home:douyin      # 只打开首页，看看能抓到什么接口
 *
 * 输出 JSON：Cookie 名称与长度、捕获到的接口、解析出的作品数。用于确认
 * 嗅探链路在当前网络 / 账号状态下是否可用。
 */

const { app } = require('electron');
const { BrowserHost } = require('./browser-host');
const { ProfileParser } = require('./parser');
const platforms = require('./platforms');
const U = require('./platforms/util');
const fs = require('fs');
const path = require('path');

const log = (...a) => process.stdout.write(a.join(' ') + '\n');

/** 从首页推荐流里捞一个真实作者，用来端到端验证「打开主页→滚动→解析」 */
function findSecUid(root) {
  let hit = '';
  U.walkJson(root, (key, value) => {
    if (hit || !value || typeof value !== 'object' || Array.isArray(value)) return;
    if (typeof value.sec_uid === 'string' && value.sec_uid.length > 10) hit = value.sec_uid;
    else if (value.author && typeof value.author.sec_uid === 'string' && value.author.sec_uid.length > 10) hit = value.author.sec_uid;
  });
  return hit;
}

async function run({ win }) {
  const arg = process.argv.find((a) => a.startsWith('--net-test='));
  const target = arg.slice('--net-test='.length);
  const report = { target, ok: false, steps: [] };

  try {
    let adapter;
    let url = target;
    const auto = target.startsWith('auto:');
    if (auto) {
      adapter = platforms.get(target.slice(5));
      url = adapter.homeUrl;
    } else if (target.startsWith('home:')) {
      adapter = platforms.get(target.slice(5));
      url = adapter.homeUrl;
    } else {
      adapter = platforms.detect(target);
      if (!adapter) {
        if (/xiaohongshu\.com/.test(target)) adapter = platforms.get('xhs');
        else if (/weibo\.(com|cn)/.test(target)) adapter = platforms.get('weibo');
        else if (/douyin\.com/.test(target)) adapter = platforms.get('douyin');
      }
      if (!adapter) throw new Error('无法识别平台');
    }
    const isProfilePage = !!platforms.get(adapter.id).matchUrl(target);

    const host = new BrowserHost(win, adapter);
    const bounds = win.getContentBounds();
    host.setBounds({ x: Math.round(bounds.width * 0.55), y: 130, width: 420, height: 620 });
    host.show();

    const seenApis = [];
    const matched = [];
    let secUid = '';
    host.sniffer.attach();
    host.sniffer.setCollector([/./], (json, u) => {
      const short = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      seenApis.push(short);
      if (auto && !secUid) secUid = findSecUid(json);
      if (adapter.listMatchers.some((m) => m.test(u)) && matched.length < 2) {
        matched.push({ url: short, keys: Object.keys(json || {}), preview: JSON.stringify(json).slice(0, 1200) });
      }
    });

    const parser = new ProfileParser(host, adapter);
    await host.load(url, { timeout: 40000 });
    await new Promise((r) => setTimeout(r, 3500));

    const cookies = await host.session.cookies.get({});
    report.cookies = cookies.map((c) => ({ name: c.name, len: String(c.value || '').length }));
    report.loggedIn = await parser.isLoggedIn();
    report.loadedUrl = host.webContents.getURL();
    report.title = await host.eval('document.title');
    report.apis = [...new Set(seenApis)].slice(0, 40);
    report.matched = matched;
    report.requestLog = host.sniffer.log
      .filter((r) => /statuses|profile|container|aweme|sns\/web/i.test(r.url))
      .map((r) => ({ url: r.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0], status: r.status, mime: r.mime }))
      .slice(-25);

    if (process.env.TUTU_PROBE_SEQ) {
      const dir = process.env.TUTU_PROBE_SEQ;
      const steps = fs.readdirSync(dir).filter((f) => /^s\d+.*\.js$/.test(f)).sort();
      const seq = [];
      for (const f of steps) {
        const code = fs.readFileSync(path.join(dir, f), 'utf8');
        const t0 = Date.now();
        const out = await host.eval(code).catch((e) => 'ERR ' + e.message);
        seq.push({ step: f, ms: Date.now() - t0, url: host.webContents.getURL(), out });
        if (/wait/.test(f)) await new Promise((r) => setTimeout(r, 4500));
      }
      report.seq = seq;
      report.apisSeq = [...new Set(seenApis)].slice(0, 40);
    }
    if (process.env.TUTU_PROBE_JS) {
      const code = fs.readFileSync(process.env.TUTU_PROBE_JS, 'utf8');
      report.probeJs = await host.eval(code).catch((e) => 'ERR ' + e.message);
    }
    if (process.env.TUTU_PROBE) {
      report.dom = await host.eval(`(() => {
        const q = (sel) => document.querySelectorAll(sel).length;
        const st = window.__INITIAL_STATE__ || {};
        const keys = Object.keys(st).slice(0, 20);
        let user = null;
        try { user = Object.keys(st.user || {}).slice(0, 20); } catch (e) { user = 'err'; }
        return {
          noteItems: q('section.note-item'),
          exploreLinks: q('a[href*="/explore/"]'),
          profileLinks: q('a[href*="/user/profile/"]'),
          stateKeys: keys,
          userKeys: user,
          bodyLen: document.body.innerHTML.length,
        };
      })()`).catch((e) => 'ERR ' + e.message);
      const beforeLen = seenApis.length;
      for (let i = 0; i < 2; i++) { await host.scrollStep(0.9); await new Promise((r) => setTimeout(r, 1500)); }
      report.apisAfterScroll = [...new Set(seenApis.slice(beforeLen))].slice(0, 30);
      report.matchedAfterScroll = await host.eval(`document.querySelectorAll('section.note-item, a[href*="/explore/"]').length`).catch(() => -1);
      report.firstNoteHref = await host.eval("(document.querySelector('a[href*=\"/explore/\"]')||{}).href || ''").catch((e) => 'ERR ' + e.message);
      report.domSample = await host.eval(`(() => {
        const el = document.querySelector('section.note-item') || document.querySelector('a[href*="/explore/"]');
        const a = el && (el.tagName === 'A' ? el : el.querySelector('a[href*="/explore/"]'));
        const img = el && el.querySelector('img');
        return {
          html: el ? el.outerHTML.slice(0, 600) : '',
          href: a ? a.getAttribute('href') : '',
          img: img ? (img.getAttribute('src') || '').slice(0, 120) : '',
          text: el ? (el.innerText || '').replace(/\n/g, ' | ').slice(0, 160) : '',
        };
      })()`).catch((e) => 'ERR ' + e.message);
      report.stateNotes = await host.eval(`(() => {
        try {
          const raw = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user && window.__INITIAL_STATE__.user.notes;
          const plain = raw && JSON.parse(JSON.stringify(raw));
          const arr = Array.isArray(plain) ? plain : (plain && (plain._value || plain.value)) || null;
          if (!arr) return { type: typeof plain, keys: plain ? Object.keys(plain).slice(0, 10) : null };
          const first = arr[0] || {};
          return { len: arr.length, keys: Object.keys(first).slice(0, 20), sample: JSON.stringify(first).slice(0, 600) };
        } catch (e) { return 'ERR ' + e.message; }
      })()`).catch((e) => 'ERR ' + e.message);
      if (!matched.length) {
        report.stateProbe = await host.eval(`(() => {
          const st = window.__INITIAL_STATE__ || {};
          const u = st.user || {};
          const out = { hasNotes: false, notesLen: 0, hasFeeds: false };
          try {
            out.userKeys = Object.keys(u);
            if (Array.isArray(u.notes)) { out.hasNotes = true; out.notesLen = u.notes.length; }
            if (Array.isArray(u.noteQueries)) { out.hasFeeds = true; out.notesLen = u.noteQueries.length; }
          } catch (e) {}
          return out;
        })()`).catch((e) => 'ERR ' + e.message);
      }
    }

    if (adapter.id === 'xhs') {
      report.pageUser = await host.eval(`(() => {
        try {
          const s = window.__INITIAL_STATE__ || {};
          const u = s.user || {};
          return JSON.stringify({ keys: Object.keys(s).slice(0, 12), loggedIn: u.loggedIn, hasInfo: !!(u.userInfo || u.user), nickname: (u.userInfo || u.user || {}).nickname || '' });
        } catch (e) { return 'ERR ' + e.message; }
      })()`);
    }

    if (auto) {
      report.discoveredSecUid = secUid;
      if (secUid) url = `https://www.douyin.com/user/${secUid}`;
      else throw new Error('首页推荐流里没找到作者，无法自动验证');
    }

    if (!target.startsWith('home:') && isProfilePage) {
      try {
        const res = await parser.parseProfile(url, { maxScrolls: 4, onProgress: (p) => report.steps.push(p.message) });
        report.ok = true;
        report.profileUrl = url;
        report.itemCount = res.items.length;
        report.author = res.author;
        report.sample = res.items.slice(0, 5).map((it) => ({
          id: it.id,
          title: (it.title || '').slice(0, 24),
          type: it.type,
          assets: it.assets.length,
        }));
      } catch (e) {
        report.parseError = String((e && e.message) || e);
        report.ok = false;
      }
    } else {
      report.ok = true;
    }
    host.destroy();
  } catch (e) {
    report.error = String((e && e.message) || e);
  }

  process.stdout.write('NET_RESULT=' + JSON.stringify(report) + '\n', () => app.exit(report.ok ? 0 : 1));
}

module.exports = { run };
