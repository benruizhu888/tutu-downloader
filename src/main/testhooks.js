'use strict';

/**
 * 仅用于自动化测试的钩子。
 * 生产运行时为空对象，main.js 里的分支不会命中。
 */
module.exports = {
  fakeParse: null,
  fakeDetails: null,
  // 打开目录/文件的调用记录（E2E 用它验证「下载完不再自动打开目录」）
  openPath: null,
};
