// C:\video-proxy\server.js
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

app.get('/api/fetch', async (req, res) => {
  let target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No url query provided' });

  try {
    // 1) expand share/r/* to the final target if it’s a FB share link
    const host = new URL(target).hostname.replace(/^www\./, '');
    if (/facebook\.com$/i.test(host) && /\/share\//i.test(target)) {
      target = await resolveRedirectChain(target);
    }

    // 2) try original → m. → mbasic.
    const candidates = altHosts(target);
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
   New: streaming downloader
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
      // ensure .mp4 if looks like a raw blob
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
    // Forward Range (resume/seek) & use media-friendly UA
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

    // Propagate important headers
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

    // Use upstream status (200/206)
    res.status(r.status);
    r.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send('Download failed');
  }
});

app.get('/', (_req, res) => {
  res.type('text/plain').send('Video proxy is running. Use /api/fetch?url=... and /api/download?url=...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running at http://localhost:${PORT}`));
