'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  downloadDir: '',
  concurrency: 3,
  lastUrls: { xhs: '', weibo: '', douyin: '' },
  maxScrolls: 40,
  detectLive: true,
};

class Store {
  constructor(fileName = 'settings.json') {
    this.file = path.join(app.getPath('userData'), fileName);
    this.data = { ...DEFAULTS, lastUrls: { ...DEFAULTS.lastUrls } };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        ...DEFAULTS,
        ...parsed,
        lastUrls: { ...DEFAULTS.lastUrls, ...(parsed.lastUrls || {}) },
      };
    } catch {
      // 首次运行或文件损坏，用默认值
    }
    if (!this.data.downloadDir) {
      this.data.downloadDir = path.join(app.getPath('downloads'), '兔兔下载');
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('保存设置失败', e);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch = {}) {
    this.data = { ...this.data, ...patch, lastUrls: { ...this.data.lastUrls, ...(patch.lastUrls || {}) } };
    this.save();
    return this.data;
  }
}

module.exports = { Store, DEFAULTS };
