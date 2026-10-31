'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractEmbeddedState, readBalancedObject, safeJson } = require('../../src/main/sniffer');
const { findNodeById, assetsFromNode, harvestFromState } = require('../../src/main/parser');
const xhs = require('../../src/main/platforms/xiaohongshu');
const douyin = require('../../src/main/platforms/douyin');

test('safeJson 只接受 JSON，拒绝 HTML 与空体', () => {
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.equal(safeJson('<html></html>'), null);
  assert.equal(safeJson(''), null);
  assert.equal(safeJson('{bad json'), null);
});

test('readBalancedObject 能跨过字符串里的花括号', () => {
  const src = 'var x = {"a":"}{","b":{"c":[1,2]}}; tail';
  const obj = readBalancedObject(src, src.indexOf('{'));
  assert.equal(obj.a, '}{');
  assert.deepEqual(obj.b.c, [1, 2]);
});

test('extractEmbeddedState 提取 __INITIAL_STATE__ 并兼容 undefined', () => {
  const html = `<html><script>window.__INITIAL_STATE__={"note":{"id":"1","desc":undefined,"list":[{"x":2}]}}</script></html>`;
  const states = extractEmbeddedState(html);
  assert.equal(states.length, 1);
  assert.equal(states[0].note.id, '1');
  assert.equal(states[0].note.desc, null);
  assert.equal(states[0].note.list[0].x, 2);
});

test('extractEmbeddedState 支持抖音 _ROUTER_DATA 与多个状态块', () => {
  const html = `
    <script id="RENDER_DATA" type="application/json">{"app":1}</script>
    <script>window._ROUTER_DATA = {"loaderData":{"page":{"aweme_list":[]}}}</script>`;
  const states = extractEmbeddedState(html);
  assert.ok(states.some((s) => s.loaderData && s.loaderData.page));
});

test('findNodeById 在深层结构里定位作品节点', () => {
  const state = { a: { b: [{ note_id: 'x1', title: 't' }, { note_id: 'x2' }] } };
  const node = findNodeById(state, 'x2');
  assert.equal(node.note_id, 'x2');
  assert.equal(findNodeById(state, 'nope'), null);
});

test('assetsFromNode：图片与视频等量时逐条实况；不等量时多余图片保留', () => {
  const nodeLive = {
    image_list: [
      { url_default: 'https://p.com/1.jpg' },
      { url_default: 'https://p.com/2.jpg' },
    ],
    video: {
      media: {
        stream: {
          h264: [
            { master_url: 'https://v.com/1.mp4' },
            { master_url: 'https://v.com/2.mp4' },
          ],
        },
      },
    },
  };
  const live = assetsFromNode(xhs, nodeLive, { type: 'live' });
  assert.equal(live.length, 2);
  assert.ok(live.every((a) => a.kind === 'live'));

  const mixed = assetsFromNode(
    xhs,
    {
      image_list: [{ url_default: 'https://p.com/1.jpg' }, { url_default: 'https://p.com/2.jpg' }],
      video: { media: { stream: { h264: [{ master_url: 'https://v.com/1.mp4' }] } } },
    },
    { type: 'live' }
  );
  assert.equal(mixed.filter((a) => a.kind === 'live').length, 1);
  assert.equal(mixed.filter((a) => a.kind === 'image').length, 1, '多出来的静态图不能丢');

  const onlyVideo = assetsFromNode(xhs, { video: { media: { stream: { h264: [{ master_url: 'https://v.com/x.mp4' }] } } } }, { type: 'video' });
  assert.equal(onlyVideo.length, 1);
  assert.equal(onlyVideo[0].kind, 'video');

  const onlyImages = assetsFromNode(xhs, { image_list: [{ url_default: 'https://p.com/a.jpg' }] }, { type: 'image' });
  assert.equal(onlyImages[0].kind, 'image');
});

test('harvestFromState 兜底：接口没命中时也能从页面状态里扫出作品', () => {
  const state = {
    loaderData: {
      page: {
        aweme_list: [
          {
            aweme_id: '7390000000000000001',
            desc: '兜底作品',
            author: { nickname: '兔子' },
            video: { play_addr: { url_list: ['https://v.com/a.mp4'] } },
          },
        ],
      },
    },
  };
  const items = harvestFromState(douyin, state);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '7390000000000000001');
  assert.equal(items[0].assets[0].kind, 'video');
});

test('extractEmbeddedState 兼容首页状态里的 new Map()/new Set()（小红书真实写法）', () => {
  // 实测：xhs 的 window.__INITIAL_STATE__ 里混着 new Map([]) / new Set() 这类 JS 字面量，
  // 直接 JSON.parse 会失败，导致整块状态取不到（实况图的视频就在这里面）
  const html = `<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{},"redmojiTailMap":new Map([]),"tags":new Set(),"t":new Date(0),"n":undefined,"x":NaN}}</script></html>`;
  const states = extractEmbeddedState(html);
  assert.equal(states.length, 1, '含 JS 构造调用的状态也要能解析出来');
  assert.deepEqual(states[0].note.noteDetailMap, {});
  assert.equal(states[0].note.redmojiTailMap, null);
  assert.equal(states[0].note.x, null);
});

test('readBalancedObject 兼容尾随逗号', () => {
  const src = 'x = {"a":1,"b":[1,2,],}';
  const obj = readBalancedObject(src, src.indexOf('{'));
  assert.equal(obj.a, 1);
  assert.deepEqual(obj.b, [1, 2]);
});
