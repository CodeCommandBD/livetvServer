const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

app.use(cors());

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL required');

  try {
    const response = await axios({
      url: targetUrl,
      method: 'GET',
      responseType: 'arraybuffer', // Handle both text and binary data
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Referer': new URL(targetUrl).origin
      },
      timeout: 10000 // 10 second timeout
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // If it's a playlist, we must rewrite the URLs inside it
    if (contentType.includes('mpegurl') || contentType.includes('application/x-mpegURL') || targetUrl.includes('.m3u8')) {
      let m3u8Content = response.data.toString('utf8');
      
      const lines = m3u8Content.split('\n');
      const rewrittenLines = lines.map(line => {
        let trimmedLine = line.trim();
        if (!trimmedLine) return '';
        
        // Handle URI="..." inside tags like #EXT-X-KEY or #EXT-X-MEDIA
        if (trimmedLine.startsWith('#')) {
          return trimmedLine.replace(/URI="(.*?)"/g, (match, uri) => {
            const absoluteUri = new URL(uri, targetUrl).href;
            const proxiedUri = `/proxy?url=${encodeURIComponent(absoluteUri)}`;
            return `URI="${proxiedUri}"`;
          });
        }
        
        // If it's a direct URL line (TS segment or nested M3U8)
        const absoluteUri = new URL(trimmedLine, targetUrl).href;
        return `/proxy?url=${encodeURIComponent(absoluteUri)}`;
      });
      
      return res.send(rewrittenLines.join('\n'));
    }

    // If it's a video chunk (.ts) or anything else, send as is
    res.send(response.data);

  } catch (error) {
    console.error(`Proxy error for ${targetUrl}:`, error.message);
    res.status(500).send('Proxy error');
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend proxy server running on port ${PORT}`);
});
