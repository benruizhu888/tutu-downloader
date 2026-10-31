'use strict';

/**
 * 登录态判定回归测试。
 *
 * 背景：小红书/微博/抖音都是 SPA，登录组件常年挂在 DOM 里（display:none）。
 * 旧实现用 `!!document.querySelector('.login-container, …')` 判断，
 * 只要命中就算未登录 → 用户登录成功后界面仍然提示「请先登录」，
 * 只能反复登录。这里把「隐藏登录层」「可见登录层」「无 Cookie」三种情形钉死。
 */

const test = require('node:test');
const assert = require('node:assert');

const { ProfileParser } = require('../../src/main/parser');

/** 假 host：cookies 与页面脚本都可控 */
function fakeHost({ cookies = [], evalResult = false } = {}) {
  return {
    session: {
      cookies: {
        get: async () => cookies,
      },
    },
    webContents: {
      getURL: () => 'https://www.xiaohongshu.com/user/profile/abc',
    },
    eval: async () => evalResult,
  };
}

const xhs = { id: 'xhs', homeUrl: 'https://www.xiaohongshu.com' };
const weibo = { id: 'weibo', homeUrl: 'https://weibo.com' };
const douyin = { id: 'douyin', homeUrl: 'https://www.douyin.com' };

const cookie = (name, value = 'a'.repeat(32)) => ({ name, value });

test('登录判定：有 Cookie 且页面无可见登录层 → 已登录', async () => {
  const p = new ProfileParser(fakeHost({ cookies: [cookie('web_session')], evalResult: false }), xhs);
  assert.strictEqual(await p.isLoggedIn(), true);
});

test('登录判定：登录层只是挂在 DOM 里（不可见）→ 已登录（这就是原 bug）', async () => {
  // eval 返回 false 表示「没有可见登录层」；旧实现用 querySelector 命中即算，
  // 这里等价于「节点存在但不可见」，必须是已登录
  const p = new ProfileParser(fakeHost({ cookies: [cookie('web_session')], evalResult: false }), xhs);
  const st = await p.loginState();
  assert.deepStrictEqual(st, { cookie: true, ui: false });
  assert.strictEqual(await p.isLoggedIn(), true);
});

test('登录判定：登录层真的显示着 → 未登录', async () => {
  const p = new ProfileParser(fakeHost({ cookies: [cookie('web_session')], evalResult: true }), xhs);
  const st = await p.loginState();
  assert.strictEqual(st.cookie, true);
  assert.strictEqual(st.ui, true);
  assert.strictEqual(await p.isLoggedIn(), false);
});

test('登录判定：没有关键 Cookie → 未登录（且不再执行页面脚本）', async () => {
  let evaluated = false;
  const host = fakeHost({ cookies: [], evalResult: true });
  host.eval = async () => { evaluated = true; return true; };
  const p = new ProfileParser(host, xhs);
  assert.deepStrictEqual(await p.loginState(), { cookie: false, ui: false });
  assert.strictEqual(await p.isLoggedIn(), false);
  assert.strictEqual(evaluated, false, '没有 Cookie 时不该再去页面里查登录层');
});

test('登录判定：Cookie 值过短（占位/被清空）不算登录', async () => {
  const p = new ProfileParser(fakeHost({ cookies: [cookie('web_session', 'short')] }), xhs);
  assert.strictEqual(await p.isLoggedIn(), false);
});

test('登录判定：Cookie 读取抛错时按未登录处理，不崩溃', async () => {
  const host = fakeHost();
  host.session.cookies.get = async () => { throw new Error('boom'); };
  const p = new ProfileParser(host, xhs);
  assert.strictEqual(await p.isLoggedIn(), false);
});

test('登录判定：页面脚本超时 → 不判定为「有登录层」（避免误伤）', async () => {
  const host = fakeHost({ cookies: [cookie('web_session')] });
  host.eval = () => new Promise(() => {}); // 永不返回
  const p = new ProfileParser(host, xhs);
  assert.strictEqual(await p.visibleLoginUi('xhs'), false);
  assert.strictEqual(await p.isLoggedIn(), true);
});

test('登录判定：微博游客 Cookie + 无登录表单 → 视为已登录（后台接口仍会兜底）', async () => {
  const p = new ProfileParser(fakeHost({ cookies: [cookie('SUB')], evalResult: false }), weibo);
  assert.strictEqual(await p.isLoggedIn(), true);
});

test('登录判定：微博显示登录表单 → 未登录', async () => {
  const p = new ProfileParser(fakeHost({ cookies: [cookie('SUB')], evalResult: true }), weibo);
  assert.strictEqual(await p.isLoggedIn(), false);
});

test('登录判定：抖音用 sessionid，且同样尊重可见登录层', async () => {
  const ok = new ProfileParser(fakeHost({ cookies: [cookie('sessionid')], evalResult: false }), douyin);
  assert.strictEqual(await ok.isLoggedIn(), true);

  const modal = new ProfileParser(fakeHost({ cookies: [cookie('sessionid')], evalResult: true }), douyin);
  assert.strictEqual(await modal.isLoggedIn(), false);
});

test('登录判定：未打开页面时（about:blank）不执行页面脚本', async () => {
  let evaluated = false;
  const host = fakeHost({ cookies: [cookie('web_session')] });
  host.webContents.getURL = () => 'about:blank';
  host.eval = async () => { evaluated = true; return true; };
  const p = new ProfileParser(host, xhs);
  assert.strictEqual(await p.isLoggedIn(), true);
  assert.strictEqual(evaluated, false);
});
