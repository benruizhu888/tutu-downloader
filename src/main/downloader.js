'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sanitizeName, extFromUrl, extFromContentType } = require('./platforms/util');
const { ensureMp4 } = require('./media');

class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'CancelledError';
  }
}

const RETRY_DELAYS = [600, 1600, 3200];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new CancelledError());
      }, { once: true });
    }
  });
}

/**
 * 单文件下载：支持断点续传（Range）、失败重试、进度回调。
 */
async function fetchToFile(url, target, {
  session,
  fetchImpl,
  headers = {},
  referer = '',
  onProgress = () => {},
  signal,
  attempts = 3,
} = {}) {
  const partPath = target + '.part';
  const doFetch = fetchImpl || ((u, o) => session.fetch(u, o));
  let lastErr = null;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) throw new CancelledError();
    if (attempt > 0) await sleep(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)], signal);

    let start = 0;
    try {
      const st = await fsp.stat(partPath);
      start = st.size;
    } catch {}

    const reqHeaders = { ...headers };
    // Referer 由会话层注入（fetch 的 Referer 属禁止头，直接传会被 Chromium 拦截）
    if (!reqHeaders.Referer && referer) reqHeaders.Referer = referer;
    if (start > 0) reqHeaders.Range = `bytes=${start}-`;

    let res;
    try {
      res = await doFetch(url, { headers: reqHeaders, signal, redirect: 'follow' });
    } catch (e) {
      if (e && (e.name === 'AbortError' || (signal && signal.aborted))) throw new CancelledError();
      lastErr = new Error('网络连接失败：' + ((e && e.message) || e));
      continue;
    }

    if (res.status === 416 && start > 0) {
      // 本地残留比远端还大，丢掉重来
      await fsp.rm(partPath, { force: true }).catch(() => {});
      lastErr = new Error('断点无效，正在重新下载');
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('没有下载权限（可能需要登录，或链接已过期）');
    }
    if (res.status === 404 || res.status === 410) {
      throw new Error('文件不存在或已被删除');
    }
    if (!res.ok && res.status !== 206) {
      lastErr = new Error(`下载失败（HTTP ${res.status}）`);
      if (res.status >= 500 || res.status === 429) continue;
      throw lastErr;
    }

    const contentType = res.headers.get('content-type') || '';
    const lenHeader = Number(res.headers.get('content-length') || 0);
    const isResume = res.status === 206;
    if (!isResume && start > 0) {
      start = 0; // 服务端不支持断点，从头写
      await fsp.rm(partPath, { force: true }).catch(() => {});
    }
    const total = lenHeader > 0 ? lenHeader + start : 0;

    let written = start;
    let lastTick = 0;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (!res.body) throw new Error('响应为空');
      const fileStream = fs.createWriteStream(partPath, { flags: isResume && start > 0 ? 'a' : 'w' });
      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => {
        written += chunk.length;
        const now = Date.now();
        if (now - lastTick > 180) {
          lastTick = now;
          onProgress(written, total);
        }
      });
      await pipeline(source, fileStream);
      onProgress(written, total || written);
    } catch (e) {
      if (signal && signal.aborted) throw new CancelledError();
      lastErr = new Error('传输中断：' + ((e && e.message) || e));
      continue;
    }

    const size = (await fsp.stat(partPath)).size;
    if (total > 0 && size !== total) {
      lastErr = new Error('文件不完整，将重试');
      continue;
    }
    if (size === 0) {
      lastErr = new Error('下载到的文件为空');
      continue;
    }
    await fsp.rename(partPath, target).catch(async () => {
      await fsp.rm(target, { force: true });
      await fsp.rename(partPath, target);
    });
    return { path: target, bytes: size, total: total || size, contentType };
  }
  throw lastErr || new Error('下载失败');
}

function pickExt(url, contentType) {
  return extFromContentType(contentType) || extFromUrl(url) || 'bin';
}

/** 这类错误说明「地址是对的，只是没通过风控」，值得换页面通道再试一次 */
function needsPageFallback(err) {
  const msg = String((err && err.message) || '');
  return /没有下载权限|HTTP 403|HTTP 401|HTTP 429/.test(msg);
}

/**
 * 本机 / 局域网地址不要带 Referer。
 * 除了没必要（这些地址不校验来源），还因为带上公网 Referer 后，
 * Chromium 会把它当成「公网页面访问内网」，直接 ERR_BLOCKED_BY_CLIENT 拦掉。
 */
function isLocalHost(url) {
  try {
    const h = String(new URL(url).hostname || '').toLowerCase();
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return /\.local$/.test(h);
  } catch {
    return false;
  }
}

function assetLabel(kind, index, total) {
  const base = kind === 'live' ? '实况' : kind === 'video' ? '视频' : '图片';
  if (total === 1) return base;
  return `${String(index + 1).padStart(2, '0')}_${base}`;
}

/** 作品落盘目录：根目录/平台/作者/标题_id */
function itemDir(rootDir, platformName, item) {
  const author = sanitizeName(item.author || '未知作者', '未知作者', 40);
  const title = sanitizeName(item.title || item.id, '未命名作品', 40);
  const shortId = String(item.id).slice(-10);
  return path.join(rootDir, platformName, author, `${title}_${shortId}`);
}

class Downloader {
  /**
   * @param {object} opts { rootDir, concurrency, getSession, onEvent }
   */
  constructor(opts) {
    this.rootDir = opts.rootDir;
    this.concurrency = Math.max(1, Math.min(6, opts.concurrency || 3));
    this.getSession = opts.getSession;
    this.fetchImpl = opts.fetchImpl || null;
    // (platformId, url) => { buffer, contentType } | null
    // 主进程请求被 CDN 拒绝时，用平台页面自己发一次请求兜底
    this.pageFallback = opts.pageFallback || null;
    this.onEvent = opts.onEvent || (() => {});
    this.controllers = new Map();
    this.stopped = false;
    this.active = 0;
  }

  cancel() {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
  }

  /**
   * @param {Array} tasks [{ item, platform }]
   */
  async run(tasks) {
    this.stopped = false;
    const results = [];
    let cursor = 0;
    const total = tasks.length;
    this.onEvent({ type: 'summary', phase: 'start', total });

    const worker = async () => {
      while (true) {
        if (this.stopped) return;
        const idx = cursor++;
        if (idx >= total) return;
        const task = tasks[idx];
        const result = await this._runItem(task, idx, total);
        results.push(result);
        this.onEvent({ type: 'item-done', index: idx, total, ...result });
      }
    };

    const runners = Array.from({ length: Math.min(this.concurrency, total || 1) }, () => worker());
    await Promise.all(runners);

    const summary = {
      total,
      success: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'failed').length,
      canceled: results.filter((r) => r.status === 'canceled').length,
    };
    this.onEvent({ type: 'summary', phase: 'done', ...summary, results });
    return summary;
  }

  async _runItem(task, index, total) {
    const { item, platform } = task;
    // CDN 基本都校验 Referer，缺了就是 403。
    // 注意：会话层 onBeforeSendHeaders 注入的 Referer 对主进程 fetch 不生效（实测被丢掉），
    // 必须在请求头里显式带上——这三个平台的 CDN 都吃这一套。
    // 本机/局域网地址除外（见 isLocalHost）。
    const platformReferer = (platform && platform.referer) || '';
    const refererFor = (u) => (isLocalHost(u) ? '' : platformReferer);
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    const dir = itemDir(this.rootDir, platform.name || platform.id, item);
    const files = [];
    const notes = [];
    const skipped = [];
    const assets = item.assets && item.assets.length ? item.assets : [];
    this.onEvent({ type: 'item-start', id: item.id, index, total, title: item.title, dir, assetCount: assets.length });

    if (!assets.length) {
      this.controllers.delete(item.id);
      return { id: item.id, status: 'failed', dir, files: [], error: '没有可下载的媒体' };
    }

    try {
      for (let i = 0; i < assets.length; i++) {
        if (controller.signal.aborted) throw new CancelledError();
        const asset = assets[i];
        const label = assetLabel(asset.kind, i, assets.length);
        const tmpTarget = path.join(dir, label + '.dl');

        const report = (bytes, bytesTotal) => {
          const fraction = bytesTotal ? Math.min(1, bytes / bytesTotal) : 0;
          const overall = Math.round(((i + fraction) / assets.length) * 100);
          this.onEvent({
            type: 'item-progress',
            id: item.id,
            percent: overall,
            bytes,
            bytesTotal,
            assetIndex: i,
            assetCount: assets.length,
          });
        };

        try {
          let res;
          try {
            res = await fetchToFile(asset.url, tmpTarget, {
              session: this.fetchImpl ? null : this.getSession(platform.id),
              fetchImpl: this.fetchImpl || undefined,
              referer: refererFor(asset.url),
              signal: controller.signal,
              onProgress: report,
            });
          } catch (e) {
            if (e instanceof CancelledError || controller.signal.aborted) throw e;
            // CDN 偶发按热度/UA 拒绝主进程请求，但同一个地址由平台页面自己请求一定通过。
            // 图片体积小，走 base64 回传完全可以接受；视频太大就不走这条路。
            if (needsPageFallback(e) && this.pageFallback && asset.kind === 'image') {
              const got = await this.pageFallback(platform.id, asset.url).catch(() => null);
              if (got && got.buffer && got.buffer.length) {
                await fsp.mkdir(dir, { recursive: true });
                await fsp.writeFile(tmpTarget, got.buffer);
                res = { path: tmpTarget, bytes: got.buffer.length, total: got.buffer.length, contentType: got.contentType };
                notes.push('CDN 拒绝了直连请求，已改用页面通道下载');
              }
            }
            if (!res) {
              if (!asset.fallback) throw e;
              // 原图地址偶尔被拒（平台改了 CDN 规则），退回页面正在用的地址：
              // 画质可能略低，但总比这条作品直接失败好。先清掉半截文件，避免断点续传串了。
              await fsp.rm(`${tmpTarget}.part`, { force: true }).catch(() => {});
              res = await fetchToFile(asset.fallback, tmpTarget, {
                session: this.fetchImpl ? null : this.getSession(platform.id),
                fetchImpl: this.fetchImpl || undefined,
                referer: refererFor(asset.fallback),
                signal: controller.signal,
                onProgress: report,
              });
              notes.push('部分文件用了平台的可用版本（原图地址被拒）');
            }
          }

          const ext = asset.kind === 'image' ? (asset.ext || pickExt(asset.url, res.contentType)) : pickExt(asset.url, res.contentType);
          const finalPath = path.join(dir, `${label}.${ext}`);
          await fsp.rename(res.path, finalPath).catch(async () => {
            await fsp.rm(finalPath, { force: true });
            await fsp.rename(res.path, finalPath);
          });

          if (asset.kind === 'live' || asset.kind === 'video') {
            const out = await ensureMp4(finalPath);
            if (out.path !== finalPath) {
              await fsp.rename(out.path, path.join(dir, `${label}.mp4`)).catch(() => {});
              files.push(path.join(dir, `${label}.mp4`));
            } else {
              files.push(finalPath);
            }
            notes.push(out.note);
          } else {
            files.push(finalPath);
          }
        } catch (e) {
          if (e instanceof CancelledError || controller.signal.aborted) throw e;
          // 单个素材失败不影响其它素材，记下来继续下一个
          await fsp.rm(`${tmpTarget}.part`, { force: true }).catch(() => {});
          skipped.push({ label, reason: String((e && e.message) || e) });
        }
      }
      this.controllers.delete(item.id);
      if (!files.length) {
        return {
          id: item.id,
          status: 'failed',
          dir,
          files,
          error: skipped.length ? String(skipped[0].reason) : '没有可下载的媒体',
        };
      }
      return {
        id: item.id,
        status: 'success',
        dir,
        files,
        notes: notes.slice(0, 2).join('；'),
        error: skipped.length ? `${skipped.length} 个文件失败：${skipped[0].reason}` : '',
      };
    } catch (e) {
      this.controllers.delete(item.id);
      if (e instanceof CancelledError || controller.signal.aborted) {
        return { id: item.id, status: 'canceled', dir, files, error: '已取消' };
      }
      return { id: item.id, status: 'failed', dir, files, error: String((e && e.message) || e) };
    }
  }
}

module.exports = { Downloader, fetchToFile, itemDir, pickExt, CancelledError };
