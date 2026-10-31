'use strict';

/**
 * 内嵌平台页面（WebContentsView）的 preload。
 * 只做一件事：把页面上那个「一键解析」悬浮按钮的点击回传给主进程。
 * 页面本身拿不到 Node，也没有别的通道可用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__tutuParseBridge', {
  request: () => ipcRenderer.send('view:parse'),
});

/**
 * 兜底：页面里偶尔夹着 bitbrowser:// 之类自定义协议的链接/广告，
 * 点一下就会弹出 Windows 的「要用哪个应用打开」对话框，把应用卡住。
 * 这里在捕获阶段直接拦掉，只放行正常的网址。
 */
const OK_SCHEME = /^(https?|about|data|blob|mailto|tel|javascript):/i;

function stopCustomProtocol(e) {
  let el = e.target;
  while (el && el !== document.documentElement) {
    const href = el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url'));
    if (/^[a-z][a-z0-9+.-]*:/i.test(String(href || '')) && !OK_SCHEME.test(String(href))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    el = el.parentElement;
  }
}

window.addEventListener('click', stopCustomProtocol, true);
window.addEventListener('auxclick', stopCustomProtocol, true);

