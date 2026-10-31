'use strict';

const xhs = require('./xiaohongshu');
const weibo = require('./weibo');
const douyin = require('./douyin');

const list = [xhs, weibo, douyin];
const map = new Map(list.map((p) => [p.id, p]));

function get(id) {
  const p = map.get(id);
  if (!p) throw new Error('未知平台：' + id);
  return p;
}

/** 根据链接自动识别平台（用于「智能粘贴」） */
function detect(url) {
  for (const p of list) {
    try {
      if (p.matchUrl(url)) return p;
    } catch {}
  }
  return null;
}

module.exports = {
  list,
  get,
  detect,
  meta: list.map((p) => ({ id: p.id, name: p.name, accent: p.accent, homeUrl: p.homeUrl })),
};
