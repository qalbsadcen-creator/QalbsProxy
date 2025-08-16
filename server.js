// server.js
const express = require('express');
const fetch = require('node-fetch'); // v2
const cors = require('cors');
const { URL } = require('url');

const app = express();
app.use(cors());

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
    'Sec-Fetch-Dest': 'document'
  };
}

async function getText(url, extraHeaders = {}) {
  const u = new URL(url);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { ...headersFor(u.host), ...extraHeaders }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

function pickMeta(html, name) {
  // <meta property="og:video" content="https://...mp4">
  const re =
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function findJsonBlock(html) {
  // Try to catch any JSON blob that carries media info
  // 1) window.__additionalDataLoaded('...', {...})
  const addRe = /__additionalDataLoaded\([^,]+,\s*(\{[\s\S]*?\})\s*\)/;
  const m1 = html.match(addRe);
  if (m1) return m1[1];

  // 2) window\._sharedData = {...}
  const sharedRe = /window\._sharedData\s*=\s*(\{[\s\S]*?\});/;
  const m2 = html.match(sharedRe);
  if (m2) return m2[1];

  // 3) application/ld+json
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i;
  const m3 = html.match(ldRe);
  if (m3) return m3[1];

  return null;
}

function deepGet(obj, pathArray) {
  return pathArray.reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : null), obj);
}

async function extractInstagram(rawUrl) {
  // Normalize to https and strip query noise
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // ensure www
  url = url.replace(/^https?:\/\/instagram\.com/i, 'https://www.instagram.com');

  // Load page HTML
  const html = await getText(url, {
    'Sec-Fetch-Site': 'none',
    'Referer': 'https://www.instagram.com/'
  });

  // 1) Simple path: og:video
  const ogVideo = pickMeta(html, 'og:video');
  const ogImage = pickMeta(html, 'og:image');
  const ogTitle = pickMeta(html, 'og:title');

  if (ogVideo && /\.mp4(\?|$)/i.test(ogVideo)) {
    return {
      ok: true,
      source: 'instagram',
      type: 'video',
      video: ogVideo,
      thumb: ogImage || null,
      title: ogTitle || 'Instagram'
    };
  }

  // 2) Parse embedded JSON and try common paths
  const jsonRaw = findJsonBlock(html);
  if (jsonRaw) {
    try {
      const data = JSON.parse(jsonRaw);

      // Try several likely paths (IG changes structure often)
      const candidates = [
        // new structures
        ['items', 0, 'video_versions', 0, 'url'],
        ['graphql', 'shortcode_media', 'video_url'],
        ['entry_data', 'PostPage', 0, 'graphql', 'shortcode_media', 'video_url'],
        ['entry_data', 'PostPage', 0, 'items', 0, 'video_versions', 0, 'url'],
        ['props', 'pageProps', 'itemInfo', 'itemStruct', 'video', 'downloadAddr'], // sometimes present
      ];

      let vid = null;
      for (const path of candidates) {
        vid = deepGet(data, path);
        if (vid && typeof vid === 'string') break;
      }

      // thumbnail/title fallbacks
      const thumb =
        deepGet(data, ['graphql', 'shortcode_media', 'display_url']) ||
        ogImage ||
        null;

      const title =
        deepGet(data, ['graphql', 'shortcode_media', 'edge_media_to_caption', 'edges', 0, 'node', 'text']) ||
        ogTitle ||
        'Instagram';

      if (vid && /\.mp4(\?|$)/i.test(vid)) {
        return {
          ok: true,
          source: 'instagram',
          type: 'video',
          video: vid,
          thumb,
          title
        };
      }
    } catch (_) {
      // ignore JSON parse errors; fall through
    }
  }

  // If we got here, we couldn’t find a direct video URL
  return {
    ok: false,
    source: 'instagram',
    reason:
      'No direct link found. The post might be private, region-locked, or requires login.'
  };
}

// ===== Unified endpoint =====
app.get('/api/extract', async (req, res) => {
  const input = (req.query.url || '').toString().trim();
  if (!input) return res.status(400).json({ ok: false, error: 'Missing url' });

  let host;
  try {
    host = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input).host;
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid url' });
  }

  try {
    if (/instagram\.com$/i.test(host) || /(^|\.)(instagram\.com)$/i.test(host)) {
      const out = await extractInstagram(input);
      if (!out.ok) return res.status(422).json(out);
      return res.json(out);
    }

    // Existing handlers (Facebook, TikTok, X) go here…
    // else if (/facebook\.com$/i.test(host)) { ... }

    return res
      .status(400)
      .json({ ok: false, error: 'Unsupported host for now', host });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log('video proxy running on :3000')
);
