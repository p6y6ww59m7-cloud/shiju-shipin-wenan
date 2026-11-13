const definitions = [
  ['douyin', '抖音', ['douyin.com', 'iesdouyin.com'], 'https://www.douyin.com/'],
  ['youtube', 'YouTube', ['youtube.com', 'youtu.be'], 'https://www.youtube.com/'],
  ['bilibili', 'B站', ['bilibili.com', 'b23.tv'], 'https://www.bilibili.com/'],
  ['kuaishou', '快手', ['kuaishou.com', 'gifshow.com'], 'https://www.kuaishou.com/'],
  ['twitter', 'X / Twitter', ['twitter.com', 'x.com'], 'https://x.com/']
];
export const platforms = definitions.map(([id, label, domains, home]) => ({ id, label, domains, home }));
export function platformFor(value) {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) return null;
    return platforms.find(p => p.domains.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) || null;
  } catch { return null; }
}
export function platformVideoId(value) {
  const p = platformFor(value); if (!p) return '';
  const u = new URL(value);
  if (p.id === 'youtube') return u.hostname === 'youtu.be' ? u.pathname.split('/')[1] || '' : u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/)?.[1] || '';
  if (p.id === 'bilibili') return u.pathname.match(/\/(BV[\w]+|av\d+)/i)?.[1] || '';
  if (p.id === 'twitter') return u.pathname.match(/\/(?:status|videos|tweet)\/(\d+)/)?.[1] || '';
  if (p.id === 'kuaishou') return u.pathname.match(/\/(?:short-video|photo)\/([\w-]+)/)?.[1] || u.searchParams.get('photoId') || '';
  return u.pathname.match(/\/(?:video|note|slides|share\/video)\/(\d{10,})/)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
}

// Match the requested photo before inspecting nested URLs; recommendations are not exports.
export function kuaishouData(data, expectedId) {
  if (!expectedId) return [];
  const stack = [data], out = []; let count = 0;
  while (stack.length && count++ < 50000) {
    const o = stack.pop(); if (!o || typeof o !== 'object') continue;
    if (String(o.photoId || o.photo_id || o.id || '') === expectedId) {
      const nested = [o]; let n = 0;
      const urls = [];
      while (nested.length && n++ < 5000) {
        const v = nested.pop(); if (!v || typeof v !== 'object') continue;
        for (const [k, val] of Object.entries(v)) {
          if (typeof val === 'string' && /^(photoUrl|playUrl|play_url|url)$/i.test(k) && /^https?:\/\//.test(val) && !/\.m3u8(?:\?|$)/i.test(val) && (/video|\.mp4|kwai|ksapisrv|yximgs/.test(val) || k !== 'url')) urls.push(val);
          else if (val && typeof val === 'object') nested.push(val);
        }
      }
      for (const url of new Set(urls)) out.push({ url, title: o.caption || o.title, author: o.userName || o.user?.userName, duration: Number(o.duration || 0) / 1000,
        verified: true, source: '快手作品信息', quality: '播放画质' });
    }
    for (const child of Object.values(o)) if (child && typeof child === 'object') stack.push(child);
  }
  return out;
}
