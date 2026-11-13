import { open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { platformFor } from './platforms.mjs';

export function douyinURL(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) &&
      (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com') ||
       u.hostname === 'iesdouyin.com' || u.hostname.endsWith('.iesdouyin.com'));
  } catch { return false; }
}

export function extractLinks(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"“”‘’]+/g) || [];
  const urls = matches.map(s => s.replace(/[，。；！？、）)\]】}]+$/u, ''))
    .filter(s => platformFor(s)).map(s => {
      const u = new URL(s);
      u.hash = '';
      return u.href;
    });
  return [...new Set(urls)];
}

export function videoId(url) {
  try {
    const u = new URL(url);
    return u.pathname.match(/\/(?:video|note|slides|share\/video)\/(\d{10,})/)?.[1] ||
      u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
  } catch { return ''; }
}

export function safeName(s) {
  return String(s || '视频').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ').replace(/^\.+|\.+$/g, '').trim().slice(0, 70) || '视频';
}

export function findVideoObjects(data, expectedId) {
  if (!expectedId) return [];
  const result = [], stack = [data];
  let n = 0;
  while (stack.length && n++ < 40000) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (String(v.aweme_id || v.awemeId || '') === String(expectedId) && v.video) {
      result.push(v);
    }
    for (const child of Object.values(v)) if (child && typeof child === 'object') stack.push(child);
  }
  return result;
}

export function formatsFromObject(obj) {
  const v = obj.video || {}, out = [];
  const add = (addr, quality, score = 0) => {
    for (const url of addr?.url_list || addr?.urlList || []) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      out.push({ url, quality, score, width: addr.width || v.width, height: addr.height || v.height,
        expectedSize: Number(addr.data_size || 0), verified: true, source: '视频信息' });
    }
  };
  for (const b of v.bit_rate || v.bitRate || []) {
    // Prefer original H.264 for QuickTime / editing compatibility.
    add(b.play_addr || b.playAddr, b.gear_name || b.gearName || '高清',
      Number(b.bit_rate || b.bitRate || 0) + (b.is_h265 ? 0 : 100000000));
  }
  add(v.play_addr || v.playAddr, '播放画质', 200000000);
  add(v.play_addr_h264, 'H.264', 210000000);
  // Never rewrite a watermark URL. Export only playback resources provided by the page.
  return out.sort((a, b) => b.score - a.score).filter((v, i, a) => a.findIndex(x => x.url === v.url) === i);
}

export function mediaKind(buffer) {
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return null;
}

function contentLength(headers) {
  const range = headers.get('content-range');
  if (range) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m || Number(m[1]) !== 0 || Number(m[2]) + 1 !== Number(m[3]))
      throw new Error('服务器只返回了视频片段，未保存为完整视频。请回到播放页重新识别。');
    return Number(m[3]);
  }
  return Number(headers.get('content-length') || 0);
}

// Stream to disk, reject HTML/error pages and truncated HTTP ranges, then atomically publish.
export async function saveVideo(response, destination, { signal, onProgress = () => {}, validate } = {}) {
  if (!response.ok) throw new Error(`视频服务器返回 ${response.status}，请回播放页刷新后重试。`);
  const expected = contentLength(response.headers);
  // AVFoundation determines the demuxer from the final extension as well as file bytes.
  const partial = path.join(path.dirname(destination), `.${path.basename(destination)}.part${path.extname(destination)}`);
  const file = await open(partial, 'wx');
  let bytes = 0, head = Buffer.alloc(0);
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      const buffer = Buffer.from(chunk);
      if (head.length < 64) head = Buffer.concat([head, buffer.subarray(0, 64 - head.length)]);
      await file.write(buffer);
      bytes += buffer.length;
      onProgress(bytes, expected);
    }
    await file.close();
    if (!mediaKind(head)) throw new Error('收到的内容不是完整 MP4/WebM 视频，已丢弃。');
    if (bytes < 1024 || (expected && expected !== bytes)) throw new Error('视频下载不完整，已丢弃。请重试。');
    if (validate) await validate(partial);
    signal?.throwIfAborted();
    // Hard link gives no-overwrite semantics even if another export finishes concurrently.
    const { link } = await import('node:fs/promises');
    await link(partial, destination);
    await unlink(partial);
    return { bytes, kind: mediaKind(head) };
  } catch (e) {
    await file.close().catch(() => {});
    await unlink(partial).catch(() => {});
    throw e;
  }
}

export async function unusedPath(folder, stem, ext = 'mp4') {
  for (let n = 0; n < 10000; n++) {
    const p = path.join(folder, `${safeName(stem)}${n ? ` (${n + 1})` : ''}.${ext}`);
    try { await stat(p); } catch (e) { if (e.code === 'ENOENT') return p; throw e; }
  }
  throw new Error('同名文件过多，请整理导出目录。');
}
