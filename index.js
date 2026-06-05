const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

// Health check / keep-alive ping endpoint
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL required');

  try {
    const response = await axios({
      url: targetUrl,
      method: 'GET',
      responseType: 'stream', // Use stream for zero-latency piping
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
      },
      timeout: 12000,
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');

    // If M3U8 playlist, buffer and rewrite URLs
    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegURL') ||
      targetUrl.includes('.m3u8');

    if (isPlaylist) {
      let text = '';
      response.data.on('data', chunk => { text += chunk.toString('utf8'); });
      
      response.data.on('end', () => {
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const rewritten = text.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed) return '';
          
          if (trimmed.startsWith('#')) {
            return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
              const abs = toAbsoluteUrl(uri, baseUrl, targetUrl);
              return `URI="/proxy?url=${encodeURIComponent(abs)}"`;
            });
          }
          
          if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            return `/proxy?url=${encodeURIComponent(trimmed)}`;
          }
          
          if (!trimmed.startsWith('#')) {
            const abs = toAbsoluteUrl(trimmed, baseUrl, targetUrl);
            return `/proxy?url=${encodeURIComponent(abs)}`;
          }
          
          return trimmed;
        }).join('\n');
        
        res.send(rewritten);
      });
      
      response.data.on('error', (err) => {
        res.status(502).send('Stream error');
      });
    } else {
      // Binary stream (video segment) - PIPE DIRECTLY FOR ZERO LATENCY!
      response.data.pipe(res);
    }

  } catch (err) {
    const status = err.response?.status || 502;
    console.error(`[Proxy Error] ${status} — ${targetUrl.substring(0, 80)}`);
    res.status(status).send('Proxy error');
  }
});

function toAbsoluteUrl(uri, base, full) {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (uri.startsWith('/')) {
    try { return new URL(uri, full).href; } catch { return uri; }
  }
  return base + uri;
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
