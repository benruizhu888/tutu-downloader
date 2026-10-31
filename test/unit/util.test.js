'use strict';

const test = require('node:test');
const assert = require('node:assert');
const U = require('../../src/main/platforms/util');

test('sanitizeName 处理非法字符与保留字', () => {
  assert.equal(U.sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(U.sanitizeName('   '), '未命名');
  assert.equal(U.sanitizeName('con'), '_con');
  assert.equal(U.sanitizeName('长'.repeat(120)).length, 60);
  assert.equal(U.sanitizeName('name. '), 'name');
});

test('originalImageUrl 去掉压缩变体但保留签名参数', () => {
  assert.equal(
    U.originalImageUrl('https://sns-img-bd.xhscdn.com/a/b.jpg?imageView2/2/w/540/format/webp'),
    'https://sns-img-bd.xhscdn.com/a/b.jpg'
  );
  assert.equal(
    U.originalImageUrl('https://wx1.sinaimg.cn/mw690/abc.jpg'),
    'https://wx1.sinaimg.cn/large/abc.jpg'
  );
  // 抖音：~tplv-… 后缀参与 x-signature 计算，砍掉就 403（实测 200 → 403），必须原样返回
  const douyin = U.originalImageUrl('https://p3-sign.douyinpic.com/tos-cn-i-0813/xyz~tplv-dy-aweme-images:q75.webp?x-expires=1&x-signature=abc');
  assert.equal(
    douyin,
    'https://p3-sign.douyinpic.com/tos-cn-i-0813/xyz~tplv-dy-aweme-images:q75.webp?x-expires=1&x-signature=abc'
  );
});

test('absUrl 与 toUrlList 兼容多种写法', () => {
  assert.equal(U.absUrl('//cdn.x.com/a.jpg'), 'https://cdn.x.com/a.jpg');
  assert.equal(U.absUrl('http://cdn.x.com/a.jpg'), 'https://cdn.x.com/a.jpg');
  assert.deepEqual(U.toUrlList({ url_list: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(U.toUrlList([{ url: 'c' }, 'd']), ['c', 'd']);
  assert.deepEqual(U.toUrlList({ master_url: 'e' }), ['e']);
});

test('视频/图片判定不互相误伤', () => {
  assert.ok(U.looksLikeVideo('https://x.com/a.mp4'));
  assert.ok(!U.looksLikeVideo('https://x.com/a.jpg?imageView2'));
  assert.ok(U.looksLikeImage('https://x.com/a.webp'));
  assert.ok(U.looksLikeVideo('https://sns-video-bd.xhscdn.com/stream/1/110/258/abc'));
});

test('harvestMedia 能从任意层级捞出媒体并去重', () => {
  const payload = {
    a: { b: [{ play_addr: { url_list: ['https://v.com/1.mp4'] } }] },
    c: { pics: [{ url: 'https://p.com/1.jpg' }, { url: 'https://p.com/1.jpg' }] },
    d: 'https://p.com/2.jpg',
  };
  const { images, videos } = U.harvestMedia(payload);
  assert.deepEqual(videos, ['https://v.com/1.mp4']);
  assert.deepEqual(images, ['https://p.com/1.jpg', 'https://p.com/2.jpg']);
});

test('extFromContentType / extFromUrl', () => {
  assert.equal(U.extFromContentType('image/jpeg; charset=utf-8'), 'jpg');
  assert.equal(U.extFromContentType('video/mp4'), 'mp4');
  assert.equal(U.extFromContentType('application/octet-stream'), '');
  assert.equal(U.extFromUrl('https://a.com/x.JPEG?y=1'), 'jpg');
});

test('makeItem 依据 assets 推断类型', () => {
  assert.equal(U.makeItem({ assets: [{ kind: 'live', url: 'u' }] }).type, 'live');
  assert.equal(U.makeItem({ assets: [{ kind: 'video', url: 'u' }] }).type, 'video');
  assert.equal(U.makeItem({ assets: [{ kind: 'image', url: 'u' }] }).type, 'image');
});
