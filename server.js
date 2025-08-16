// C:\video-proxy\server.js
const express = require('express');
const fetch = require('node-fetch'); // v2
const cors = require('cors');
const { URL } = require('url');

const app = express();
app.use(cors());

/* -----------------------
   Shared request headers
   ----------------------- */
function headersFor(host) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Referer': `https://${host}/`,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
  };
}

async function fetchHtml(urlStr) {
  const u = new URL(urlStr);
  const r = await fetch(urlStr, {
    headers: headersFor(u.hostname),
    redirect: 'follow',
  });
  const html = await r.text();
  return { status: r.status, html };
}

// follow redirects *manually* to expand share/r/* to the final URL
async function resolveRedirectChain(urlStr, maxHops = 5) {
  let current = urlStr;
  for (let i = 0; i < maxHops; i++) {
    const u = new URL(current);
    const r = await fetch(current, {
      headers: headersFor(u.hostname),
      redirect: 'manual',
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString(); // support relative redirects
      continue;
    }
    return current; // not a redirect
  }
  return current;
}

function altHosts(urlStr) {
  const u = new URL(urlStr);
  const host = u.hostname.replace(/^www\./, '');
  if (!/facebook\.com$/i.test(host)) return [urlStr];

  // try original, then m., then mbasic.
  const list = [urlStr];
  const p = u.pathname + u.search + u.hash;

  list.push(`https://m.facebook.com${p}`);
  list.push(`https://mbasic.facebook.com${p}`);
  return list;
}

/* -----------------------
   Utility helpers
   ----------------------- */

// Normalize host
function normHost(h) {
  return (h || '').toLowerCase().replace(/^www\./, '');
}

// Basic JSON-ish unescape for inline strings
function unescapeJsonish(s) {
  if (!s) return s;
  return s
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

// Extract <meta property="..."> content
function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`,
    'i'
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

// De-duplicate URLs and keep stable order
function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!u) continue;
    const key = u.split('#')[0]; // ignore fragments
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

// Build a simple media list [{url,label,bitrate}]
function toMediaList(urls) {
  return uniqueUrls(urls).map(u => ({ url: u, label: guessLabel(u), bitrate: guessBitrate(u) }));
}

function guessBitrate(u) {
  // Try to infer bitrate if URL contains it
  const m = String(u).match(/(?:bitrate|br)=?(\d{3,6})/i);
  return m ? parseInt(m[1], 10) : undefined;
}

function guessLabel(u) {
  const s = String(u).toLowerCase();
  if (s.includes('hd') || s.includes('1080')) return 'HD';
  if (s.includes('720')) return '720p';
  if (s.includes('480')) return 'SD';
  if (s.includes('sd') || s.includes('360')) return 'SD';
  return 'Video';
}

function pickBestUrl(list) {
  if (!list || !list.length) return null;
  // Prefer higher bitrate when present, else first
  const withBR = list.filter(x => x.bitrate);
  if (withBR.length) {
    return withBR.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0].url;
  }
  // Prefer HD label next
  const hd = list.find(x => /hd|1080|720/i.test(x.label));
  return hd ? hd.url : list[0].url;
}

/* -----------------------
   Extractors (best-effort)
   ----------------------- */

// FACEBOOK
function extractFacebook(html) {
  // Try multiple known keys
  const keys = [
    /"browser_native_hd_url":"(https:[^"]+)"/i,
    /"browser_native_sd_url":"(https:[^"]+)"/i,
    /"playable_url_quality_hd":"(https:[^"]+)"/i,
    /"playable_url":"(https:[^"]+)"/i
  ];

  const urls = [];
  for (const re of keys) {
    const m = html.match(re);
    if (m && m[1]) urls.push(unescapeJsonish(m[1]));
  }

  // Fallback to og:video
  const ogVideo = metaContent(html, 'og:video');
  if (ogVideo) urls.push(ogVideo);

  const title = metaContent(html, 'og:title') || '';
  const thumb = metaContent(html, 'og:image') || '';

  const media = toMediaList(urls);
  return {
    platform: 'facebook',
    title,
    thumb,
    urls: media,
    bestUrl: pickBestUrl(media)
  };
}

// INSTAGRAM (public)
function extractInstagram(html) {
  // Primary: explicit video_url in JSON
  const m1 = html.match(/"video_url":"(https:[^"]+)"/i);
  const url1 = m1 ? unescapeJsonish(m1[1]) : null;

  // Fallback: ld+json contentUrl or og:video
  const ogVideo = metaContent(html, 'og:video');
  const urls = uniqueUrls([url1, ogVideo]);

  const title = metaContent(html, 'og:title') || '';
  const thumb = metaContent(html, 'og:image') || '';

  const media = toMediaList(urls);
  return {
    platform: 'instagram',
    title,
    thumb,
    urls: media,
    bestUrl: pickBestUrl(media)
  };
}

// TIKTOK (public)
function extractTikTok(html) {
  // Look for playAddr (usually mp4)
  const m1 = html.match(/"playAddr":"(https:[^"]+?)"/i);
  const url1 = m1 ? unescapeJsonish(m1[1]) : null;

  // Also check downloadAddr (may be watermarked)
  const m2 = html.match(/"downloadAddr":"(https:[^"]+?)"/i);
  const url2 = m2 ? unescapeJsonish(m2[1]) : null;

  const ogVideo = metaContent(html, 'og:video');
  const urls = uniqueUrls([url1, url2, ogVideo]);

  const title = metaContent(html, 'og:title') || '';
  const thumb = metaContent(html, 'og:image') || '';

  const media = toMediaList(urls);
  return {
    platform: 'tiktok',
    title,
    thumb,
    urls: media,
    bestUrl: pickBestUrl(media)
  };
}

// TWITTER / X (public)
function extractTwitterX(html) {
  // Try variants with content_type video/mp4
  const variantRe = /"content_type":"video\/mp4","url":"(https:[^"]+?)"/gi;
  const urls = [];
  let m;
  while ((m = variantRe.exec(html))) {
    urls.push(unescapeJsonish(m[1]));
  }

  // Fallback: og:video
  const ogVideo = metaContent(html, 'og:video');
  if (ogVideo) urls.push(ogVideo);

  const title = metaContent(html, 'og:title') || '';
  const thumb = metaContent(html, 'og:image') || '';

  const media = toMediaList(urls);
  return {
    platform: 'twitter',
    title,
    thumb,
    urls: media,
    bestUrl: pickBestUrl(media)
  };
}

/* -----------------------
   FETCH raw (unchanged)
   ----------------------- */
app.get('/api/fetch', async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No url query provided' });

  try {
    // expand Facebook share/* only
    const host = new URL(target).hostname.replace(/^www\./, '');
    if (/facebook\.com$/i.test(host) && /\/share\//i.test(target)) {
      target = await resolveRedirectChain(target);
    }

    // try original → m. → mbasic. (FB only)
    const candidates = /facebook\.com$/i.test(host) ? altHosts(target) : [target];

    let okHtml = '';
    for (const candidate of candidates) {
      try {
        const r = await fetchHtml(candidate);
        if (r.status < 400 && !/Sorry[^<]{0,50}went wrong/i.test(r.html)) {
          okHtml = r.html;
          break;
        }
      } catch (_) {}
    }

    if (!okHtml) {
      return res
        .status(502)
        .type('text/plain')
        .send('Upstream returned an error page or required login.');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(okHtml);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -----------------------
   New: /api/extract (JSON)
   Auto-detects site and extracts media links for:
   Facebook, Instagram, TikTok, Twitter/X (public posts only)
   ----------------------- */
app.get('/api/extract', async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No url query provided' });

  try {
    // Resolve up to a few redirects (covers FB share/* and others)
    target = await resolveRedirectChain(target);

    const u = new URL(target);
    const host = normHost(u.hostname);

    // For FB, try alt hosts. Others: single attempt.
    const candidates = /facebook\.com$/i.test(host) ? altHosts(target) : [target];

    let html = '';
    let finalHost = host;
    for (const cand of candidates) {
      try {
        const r = await fetchHtml(cand);
        if (r.status < 400 && r.html && r.html.length > 1000) {
          html = r.html;
          finalHost = normHost(new URL(cand).hostname);
          break;
        }
      } catch (_) {}
    }

    if (!html) {
      return res.status(502).json({ error: 'Upstream error or login required' });
    }

    let out;
    if (/facebook\.com$/i.test(finalHost)) {
      out = extractFacebook(html);
    } else if (/instagram\.com$/i.test(finalHost)) {
      out = extractInstagram(html);
    } else if (/tiktok\.com$/i.test(finalHost)) {
      out = extractTikTok(html);
    } else if (/twitter\.com$/i.test(finalHost) || /^x\.com$/i.test(finalHost)) {
      out = extractTwitterX(html);
    } else {
      return res.status(400).json({ error: `Host not supported: ${finalHost}` });
    }

    if (!out || !out.bestUrl) {
      return res.status(404).json({ error: 'No downloadable video found (public posts only)' });
    }

    res.json({
      ok: true,
      platform: out.platform,
      title: out.title || '',
      thumb: out.thumb || '',
      urls: out.urls || [],
      bestUrl: out.bestUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -----------------------
   Streaming downloader (unchanged)
   ----------------------- */

// Try to get a usable filename from headers/path
function pickFilename(upstreamUrl, r) {
  // 1) Content-Disposition filename
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }

  // 2) last path segment
  try {
    const u = new URL(upstreamUrl);
    const last = (u.pathname.split('/').pop() || '').split('?')[0];
    if (last) {
      if (/\.(mp4|mov|m4v|webm)$/i.test(last)) return last;
      return `${last}.mp4`;
    }
  } catch {}

  // 3) fallback
  return 'video.mp4';
}

app.get('/api/download', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    const u = new URL(targetUrl);
    const dlHeaders = {
      ...headersFor(u.hostname),
      'Accept': '*/*'
    };
    const clientRange = req.headers.range;
    if (clientRange) dlHeaders['Range'] = clientRange;

    const r = await fetch(targetUrl, {
      headers: dlHeaders,
      redirect: 'follow',
    });

    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const cl = r.headers.get('content-length');
    const cr = r.headers.get('content-range');
    const ar = r.headers.get('accept-ranges');

    res.setHeader('Content-Type', ct);
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (ar) res.setHeader('Accept-Ranges', ar);

    const filename = pickFilename(targetUrl, r);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.status(r.status);
    r.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send('Download failed');
  }
});

/* -----------------------
   Root
   ----------------------- */
app.get('/', (_req, res) => {
  res
    .type('text/plain')
    .send('Video proxy is running.\nUse /api/fetch?url=... to get HTML, /api/extract?url=... for JSON, and /api/download?url=... to stream.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running at http://localhost:${PORT}`));
