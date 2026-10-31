'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const xhs = require('../../src/main/platforms/xiaohongshu');
const douyin = require('../../src/main/platforms/douyin');
const weibo = require('../../src/main/platforms/weibo');
const platforms = require('../../src/main/platforms');
const U = require('../../src/main/platforms/util');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));

test('链接识别：三个平台的主页链接与短链', () => {
  assert.equal(xhs.matchUrl('https://www.xiaohongshu.com/user/profile/5f1e2d3c4b5a69788796a5b4?xsec_token=ABC%3D&xsec_source=pc_search').userId, '5f1e2d3c4b5a69788796a5b4');
  assert.ok(xhs.matchUrl('https://www.xiaohongshu.com/user/profile/5f1e2d3c4b5a69788796a5b4?xsec_token=ABC').xsecToken === 'ABC');
  assert.ok(xhs.matchUrl('https://xhslink.com/a/abc123').shortUrl);
  assert.equal(xhs.matchUrl('https://www.xiaohongshu.com/explore/66f0'), null);

  assert.equal(douyin.matchUrl('https://www.douyin.com/user/MS4wLjABAAAAtestUser01?from_tab_name=main').userId, 'MS4wLjABAAAAtestUser01');
  assert.ok(douyin.matchUrl('https://v.douyin.com/iAbCdEf/').shortUrl);

  assert.equal(weibo.matchUrl('https://weibo.com/u/1234567890').userId, '1234567890');
  assert.equal(weibo.matchUrl('https://m.weibo.cn/u/1234567890').profileUrl, 'https://weibo.com/u/1234567890');
  assert.ok(weibo.matchUrl('https://weibo.com/n/%E5%85%94%E5%AD%90').nickname);
  assert.equal(platforms.detect('https://www.douyin.com/user/xxx').id, 'douyin');
  assert.equal(platforms.detect('https://example.com/'), null);
});

test('小红书列表：仅封面 + 视频清晰度取最高', () => {
  const { items, author } = xhs.parseList(fx('xhs-user-posted.json'), {});
  assert.equal(author, '兔兔酱');
  assert.equal(items.length, 2);

  const [note, video] = items;
  assert.equal(note.type, 'image');
  assert.equal(note.assets.length, 0, '列表接口不含图集详情，应交给详情解析');
  assert.equal(xhs.needsDetail(note), true);
  // 列表封面只用于界面展示，保留平台缩略图变体（加载快）；原图由详情解析后放进 assets
  assert.ok(note.cover.includes('imageView2'), '封面保留平台缩略图变体');

  assert.equal(video.type, 'video');
  assert.equal(video.assets.length, 1);
  assert.ok(video.assets[0].url.includes('1080p'), '应选分辨率最高的码流');
  assert.equal(video.assets[0].kind, 'video');
  assert.equal(xhs.needsDetail(video), false);
  assert.ok(video.pageUrl.includes('xsec_token=ABxTk_token_2'), '详情链接要带 token');
});

test('小红书详情：实况图识别为 live，静态图取 WB_DFT 原图', () => {
  const items = xhs.parseDetail(fx('xhs-feed-detail.json'));
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.type, 'live');
  assert.equal(it.assets.length, 2);

  const [live, img] = it.assets;
  assert.equal(live.kind, 'live');
  assert.ok(live.url.endsWith('live_1.mp4'));
  assert.ok(live.still.endsWith('live_still.jpg'));
  assert.equal(img.kind, 'image');
  assert.ok(img.url.endsWith('plain_dft.jpg'), '应优先 WB_DFT 而不是预览图');
  assert.equal(img.url.includes('imageView2'), false);
});

test('抖音：图集实况 + 视频选最高码率', () => {
  const { items, hasMore } = douyin.parseList(fx('douyin-aweme-post.json'), {});
  assert.equal(hasMore, true);
  assert.equal(items.length, 2);

  const [album, videoPost] = items;
  assert.equal(album.type, 'live');
  assert.equal(album.assets.length, 2);
  assert.equal(album.assets[0].kind, 'live');
  assert.ok(album.assets[0].url.includes('live1.mp4'));
  // ~tplv-… 后缀参与 CDN 签名，删了就 403（实测 200 → 403），必须原样保留
  assert.ok(
    album.assets[0].still.startsWith('https://p3-sign.douyinpic.com/tos-cn-i-0813/live1~tplv-dy-aweme-images:q75.webp?'),
    '保留 tplv 模板后缀与签名参数'
  );
  assert.ok(album.assets[0].still.includes('x-signature=a'), '签名参数不能丢');
  assert.equal(album.assets[1].kind, 'image');
  // 同一张图有多种变体时：jpeg + 无水印优先，带水印的 download_url_list 排最后
  assert.ok(album.assets[1].still.includes('plain2~tplv-dy-aweme-images:q75.jpeg'), 'jpeg 变体比 webp 画质更好');
  assert.equal(album.assets[1].still.includes('water'), false, '不能用带水印的变体');
  // 图集作品应该打开 /note/，视频作品才是 /video/
  assert.ok(album.pageUrl.endsWith('/note/' + album.id), '图集用 /note/ 详情页');
  assert.ok(douyin.detailUrl(album).endsWith('/note/' + album.id));

  assert.equal(videoPost.type, 'video');
  assert.ok(videoPost.assets[0].url.includes('v1080h265.mp4'), '选分辨率更高的码流');
});

test('抖音：无码率列表时去掉 playwm 水印地址', () => {
  const it = douyin.normalizeAweme({
    aweme_id: '1',
    desc: 'x',
    video: { play_addr: { url_list: ['https://www.douyin.com/aweme/v1/playwm/?video_id=v0200'] } },
  });
  assert.ok(it.assets[0].url.includes('/play/'));
  assert.ok(!it.assets[0].url.includes('playwm'));
});

test('微博：九宫格取 large 原图，视频取高清流，纯文字被过滤', () => {
  const { items, author } = weibo.parseList(fx('weibo-mymblog.json'), {});
  assert.equal(author, '微博兔子');
  assert.equal(items.length, 2, '纯文字微博不应计入作品');
  assert.equal(items[0].type, 'image');
  assert.deepEqual(items[0].assets.map((a) => a.url), [
    'https://wx1.sinaimg.cn/large/abc123.jpg',
    'https://wx2.sinaimg.cn/large/def456.jpg',
  ]);
  assert.equal(items[1].type, 'video');
  assert.ok(items[1].assets[0].url.includes('abc_hd.mp4'), '优先 stream_url_hd');
  assert.equal(items[0].platform, 'weibo');
});

test('微博：HTML 文本被清洗', () => {
  assert.equal(weibo.stripHtml('a<br/>b&nbsp;<b>c</b>&amp;d'), 'a\nb c&d');
});

test('微博：标称总数只认第 1 页，翻页后接口改报的剩余量不覆盖它', async () => {
  // 真实接口：第 1 页 total=95，第 2 页起 total=70（还能翻到的量）。
  // 用后面的值会算错「主页标称」，提示文案就会写成「标称 70」。
  const pages = {
    1: { total: 95, list: [{ idstr: '101', text: 'a' }, { idstr: '102', text: 'b' }] },
    2: { total: 70, list: [{ idstr: '103', text: 'c' }] },
    3: { total: 70, list: [] },
  };
  const host = {
    pageFetchText: async (u) => {
      const p = Number((/page=(\d+)/.exec(u) || [])[1] || 0);
      return { ok: true, text: JSON.stringify({ data: pages[p] || { list: [] } }) };
    },
  };
  const r = await weibo.fetchList(host, { profileUrl: 'https://weibo.com/u/3948617045', maxPages: 3 });
  assert.equal(r.total, 95, '标称总数应保持第 1 页的 95');
  assert.equal(r.raw, 3, '接口实际下发 3 条（去重后）');
});

test('小红书原图：webpic 变体换成 ci 原图域，静态资源被排除', () => {
  const cases = [
    ['https://sns-webpic-qc.xhscdn.com/202610/abc/notes_pre_post/1040g3k0326tppva9kq005qb24c9tu6hn2k9ijbg!nd_dft_wlteh_webp_3',
      'https://ci.xiaohongshu.com/notes_pre_post/1040g3k0326tppva9kq005qb24c9tu6hn2k9ijbg'],
    ['https://sns-webpic-qc.xhscdn.com/202610/09b6b8754c9511d2f67afb89de64d971/1040g2sg3207q75k3m2hg5q4b3rca537bojj2b98!nd_dft_wlteh_webp_3',
      'https://ci.xiaohongshu.com/1040g2sg3207q75k3m2hg5q4b3rca537bojj2b98'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(U.originalImageUrl(input), expected);
    assert.ok(U.isContentImage(expected));
  }
  assert.ok(!U.isContentImage('https://picasso-static.xiaohongshu.com/fe-platform/e6214e4f.png'), '站点占位图不算作品图');
});

test('小红书：从详情页 HTML 里扫出视频与图片', () => {
  // 页面里的真实形态：JSON 转义过的斜杠（\u002F）+ HTML 转义的 &
  const escaped = String.raw`http:\u002F\u002Fsns-video-qc.xhscdn.com\u002Fstream\u002F1\u002F110\u002F258\u002F01eac0bf2f495b6901037001a100eb0ca3_258.mp4?sign=abc&amp;t=1`;
  const html = '<script>{"masterUrl":"' + escaped + '"}</script>'
    + '<img src="https://sns-webpic-qc.xhscdn.com/202610/x/notes_pre_post/1040g3k0326tppva9kq005qb24c9tu6hn2k9ijbg!nd_dft_wlteh_webp_3">';
  const r = xhs.mediaFromHtml(html);
  assert.equal(r.videos.length, 1, '应扫出 1 个视频地址');
  assert.ok(r.videos[0].startsWith('https://sns-video-qc.xhscdn.com/stream/'), '转义斜杠要还原成 ://');
  assert.equal(r.videos[0].includes('&amp;'), false, '&amp; 要还原成 &');
  assert.deepEqual(r.images, ['https://ci.xiaohongshu.com/notes_pre_post/1040g3k0326tppva9kq005qb24c9tu6hn2k9ijbg']);
});

test('小红书实况图：详情页 state 结构（stream.h264[0].masterUrl）也能出 live', () => {
  // 真实数据来自 __INITIAL_STATE__.note.noteDetailMap[id].noteCard.note.imageList[i]
  // 注意：这里没有 media 这一层，字段是驼峰 masterUrl/backupUrls，且靠 livePhoto 标记
  const card = {
    noteId: '6aaf42f50000000011039a0f',
    title: '西湖实况live',
    imageList: [
      {
        livePhoto: true,
        width: 4284,
        height: 5712,
        stream: {
          h264: [{
            masterUrl: 'http://sns-video-v4.xhscdn.com/stream/1/10/19/01eaaf422f0a3d5101005003a0bc9dd499_19.mp4?sign=abc&t=1',
            backupUrls: ['http://sns-bak-v1.xhscdn.com/stream/1/10/19/01eaaf422f0a3d5101005003a0bc9dd499_19.mp4?b=1'],
          }],
          h265: [],
          av1: [],
        },
        infoList: [{ imageScene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/202610/abc/notes_pre_post/1040g3k0325ar16nnl8005otqt0npgn7qmbrrdu8!nd_dft_wlteh_webp_3' }],
      },
      {
        infoList: [{ imageScene: 'WB_DFT', url: 'http://sns-webpic-qc.xhscdn.com/202610/def/notes_pre_post/1040g3k0325ar16nnl80g5otqt0npgn7qrlvl2h0!nd_dft_wlteh_webp_3' }],
      },
    ],
  };

  const it = xhs.normalizeNote(card, {});
  assert.equal(it.type, 'live', '含实况图的作品类型应为 live');
  assert.equal(it.assets.length, 2);
  assert.equal(it.assets[0].kind, 'live');
  assert.ok(it.assets[0].url.startsWith('https://sns-video-v4.xhscdn.com/stream/'), '取 h264 masterUrl');
  assert.equal(it.assets[0].still.includes('ci.xiaohongshu.com'), true, '静图换成 ci 原图');
  assert.equal(it.assets[1].kind, 'image', '普通图仍然是图片');

  // 适配器直接给解析器用的 state 通道
  const viaState = xhs.assetsFromState({ id: card.noteId, noteCard: { note: card } }, card.noteId);
  assert.equal(viaState.filter((a) => a.kind === 'live').length, 1);
  assert.deepEqual(xhs.assetsFromState({ note: card }, 'other-id'), [], 'id 不匹配时不乱认');
});

test('小红书实况图：笔记接口结构（video.media.stream）同样能出 live', () => {
  const card = {
    note_id: 'n1',
    image_list: [{
      live_photo: true,
      url_default: 'http://sns-webpic-qc.xhscdn.com/202610/abc/notes_pre_post/1040g3k0325ar16nnl8005otqt0npgn7qmbrrdu8!nd_dft_wlteh_webp_3',
      video: { media: { stream: { h264: [{ master_url: 'https://sns-video-bd.xhscdn.com/stream/1/110/258/abc.mp4', width: 100, height: 100 }] } } },
    }],
  };
  const it = xhs.normalizeNote(card, {});
  assert.equal(it.assets[0].kind, 'live');
  assert.ok(it.assets[0].url.includes('sns-video-bd.xhscdn.com/stream/'));
});

test('微博实况图：详情接口的 video / video_hd 出 live，且不选被截断的坏地址', () => {
  // 真实数据：/ajax/statuses/show?id=5347408106226013
  const json = {
    idstr: '5347408106226013',
    text: '实况图',
    pic_infos: {
      p1: {
        type: 'livephoto',
        fid: '003W6UA6jx08B6fxBorB0h04110021fN0k01',
        large: { url: 'https://wx2.sinaimg.cn/orj960/eb5b1d55gy1ihh2fq3qwaj22c03404jv.jpg' },
        video: 'https://video.weibo.com/media/play?livephoto=https%3A%2F%2Fus.sinaimg.cn%2F003W6UA6jx08B6fxBorB0h04110021fN0k01.mov&Expires=1793343845&ssig=x&KID=unistore,video',
        // 平台给的 hd 地址是截断的（文件名没了），选了必然下不到东西
        video_hd: 'https://video.weibo.com/media/play?livephoto=https%3A%2F%2Fus.sinaimg.cn%2F.mov',
      },
      p2: { large: { url: 'https://wx3.sinaimg.cn/orj960/plain2.jpg' } },
    },
  };

  const [it] = weibo.parseDetail(json);
  assert.equal(it.type, 'live');
  assert.equal(it.assets.length, 2);
  assert.equal(it.assets[0].kind, 'live');
  assert.ok(it.assets[0].url.includes('003W6UA6jx08B6fxBorB0h04110021fN0k01.mov'), '选可用的 media/play 地址');
  assert.equal(/sinaimg\.cn%2F\.mov/i.test(it.assets[0].url), false, '不能选 video_hd 的截断地址');
  assert.ok(it.assets[0].still.includes('/large/'), '静图取 large 原图');
  assert.equal(it.assets[1].kind, 'image', '普通图不受影响');
});

test('小红书：noteFromStateHtml 能从 SSR HTML 里取到笔记（含 Live 视频流）', () => {
  // 模拟真实笔记页的 __INITIAL_STATE__：合法 JSON + 一处 JS 字面量（new Map()），
  // 小红书真实页面就是这样混着写的。
  const note = {
    noteId: '6aaf42f50000000011039a0f',
    title: '一只兔子',
    desc: '正文',
    time: 1700000000000,
    user: { nickname: '示例作者D' },
    imageList: [
      { livePhoto: true, urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a/1!nd_dft_wlteh_webp_3', stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/1/110/258/live1.mp4', width: 1080, height: 1440 }] } },
      { livePhoto: true, urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a/2!nd_dft_wlteh_webp_3', stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/1/110/258/live2.mp4', width: 1080, height: 1440 }] } },
      { livePhoto: true, urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a/3!nd_dft_wlteh_webp_3', stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/1/110/258/live3.mp4', width: 1080, height: 1440 }] } },
    ],
  };
  const state = JSON.stringify({
    global: { redmojiTailMap: 'new Map([])' },
    note: { noteDetailMap: { '6aaf42f50000000011039a0f': { note } } },
  }).replace('"new Map([])"', 'new Map([])');
  const html = `<html><script>window.__INITIAL_STATE__=${state}</script></html>`;
  const got = xhs.noteFromStateHtml(html, '6aaf42f50000000011039a0f');
  assert.ok(got, '能从 SSR HTML 里取到笔记');
  assert.equal(got.title, '一只兔子');
  const it = xhs.normalizeNote(got, {});
  assert.equal(it.type, 'live', '三条都是 Live');
  assert.equal(it.assets.length, 3);
  assert.ok(it.assets.every((a) => a.kind === 'live'));
  assert.ok(it.assets.every((a) => a.url.includes('sns-video-bd.xhscdn.com/stream/')));
  assert.ok(it.assets.every((a) => a.still), '每条 Live 都要有配对静图');
  assert.equal(it.author, '示例作者D');
  // id 不匹配时不应乱认
  assert.equal(xhs.noteFromStateHtml(html, 'other-id'), null);
});

test('小红书：fetchDetail / prefetchDetails 能识别 Live 并回填元数据', async () => {
  const noteId = '6aaf42f50000000011039a0f';
  const note = {
    noteId,
    title: '实况笔记标题',
    desc: '正文内容',
    time: 1700000000000,
    user: { nickname: '示例作者D' },
    imageList: [
      { livePhoto: true, urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a/1.jpg', stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/1/110/258/l1.mp4', width: 1080, height: 1440 }] } },
      { livePhoto: true, urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a/2.jpg', stream: { h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/1/110/258/l2.mp4', width: 1080, height: 1440 }] } },
    ],
  };
  const state = JSON.stringify({ note: { noteDetailMap: { [noteId]: { note } } } });
  const html = `<html><script>window.__INITIAL_STATE__=${state}</script></html>`;

  // 假 host：只提供 fetchPageHtml
  const host = {
    fetchPageHtml: async (url) => {
      assert.ok(url.includes(`xsec_token=`), '笔记页必须带 xsec_token');
      assert.ok(url.includes('/explore/'), '走标准笔记地址');
      return html;
    },
  };

  const item = { id: noteId, _xsecToken: 'TOK%3D', title: '笔记 6aaf42f50000000011039a0f', assets: [] };
  const [got] = await xhs.fetchDetail(host, item);
  assert.ok(got, 'fetchDetail 能取到笔记');
  assert.equal(got.type, 'live');
  assert.equal(got.assets.length, 2);
  assert.equal(got.title, '实况笔记标题');
  assert.equal(got.author, '示例作者D');

  // prefetchDetails：列表阶段只有封面（assets 为空）→ 预取后要认出 live
  const items = [
    { id: noteId, _xsecToken: 'TOK%3D', assets: [], title: '', author: '' },
    { id: 'plain1', _xsecToken: 'TOK%3D', assets: [{ kind: 'image', url: 'http://x/1.jpg' }], title: '普通图' },
  ];
  const stat = await xhs.prefetchDetails(host, items, { concurrency: 2 });
  assert.equal(stat.total, 1, '只预取没有资源的条目');
  assert.equal(stat.ok, 1);
  assert.equal(stat.live, 1);
  assert.equal(items[0].type, 'live');
  assert.equal(items[0]._detailFetched, true, '标记已取过详情，下载前不再重复请求');
  assert.equal(items[0].title, '实况笔记标题');
  assert.equal(items[0].author, '示例作者D');
  assert.equal(items[1]._detailFetched, undefined, '已有资源的条目不动');
});

test('实况资产降级：关掉「实况图导出为 MP4」后只保留静图', () => {
  const assets = [
    { kind: 'live', url: 'https://v/live.mp4', still: 'https://i/still.jpg', ext: 'mp4' },
    { kind: 'image', url: 'https://i/p.jpg', still: 'https://i/p.jpg', ext: '' },
    { kind: 'video', url: 'https://v/v.mp4', still: 'https://i/v.jpg', ext: 'mp4' },
  ];
  const out = U.downgradeLiveAssets(assets);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'image');
  assert.equal(out[0].url, 'https://i/still.jpg');
  assert.equal(out[1].kind, 'image');
  assert.equal(out[2].kind, 'video', '普通视频不受影响');
  // 没有配对静图的 live 只能丢掉（不能拿视频冒充图片）
  const out2 = U.downgradeLiveAssets([{ kind: 'live', url: 'https://v/live.mp4', still: '' }]);
  assert.equal(out2.length, 0);
});

test('小红书：stream 键名被平台混淆（EF4/EF5…）后仍能取出实况视频流', () => {
  // 实测：访问过作者主页后，平台会把 stream 的编码键名混淆掉，
  // 正常态是 h264/h265/av1，混淆态是 EF4/EF5/EF6/EF7 —— 键名每次都不一样。
  // 流地址本身没变，写死键名就会漏掉实况视频。
  const img = {
    livePhoto: true,
    urlDefault: 'http://sns-webpic-qc.xhscdn.com/202610/a/1!nd_dft_wlteh_jpg_3',
    stream: {
      EF6: [],
      EF5: [],
      EF7: [],
      EF4: [{
        qualityType: 'HD',
        masterUrl: 'http://sns-video-v4.xhscdn.com/stream/1/10/19/live_ef4.mp4?b=x&csig=y',
        backupUrls: ['http://sns-bak-v1.xhscdn.com/stream/1/10/19/live_ef4.mp4?b=x&csig=y'],
      }],
    },
  };
  const it = xhs.normalizeNote({ note_id: 'n1', image_list: [img] }, {});
  assert.equal(it.type, 'live', '混淆键名下也必须认成 live');
  assert.equal(it.assets.length, 1);
  assert.equal(it.assets[0].kind, 'live');
  assert.ok(it.assets[0].url.includes('live_ef4.mp4'), '要取到混淆键里的那条流');
  assert.ok(it.assets[0].still, '静图仍要保留');
});
