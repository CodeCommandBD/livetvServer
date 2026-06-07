require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const connectDB = require('./config/db');

// Connect to MongoDB
connectDB();

const app = express();

const allowedOrigins = [
  'https://kriya-tv.vercel.app',
  'http://localhost:5173'
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Mount the Full-Stack API
app.use('/api', require('./api'));

// Initialize Background Automation Engine
const { initCronJobs } = require('./cron');
initCronJobs();

// Global State for Kill Switch
global.serverStatus = 'online';
const activeIps = new Map();

global.getActiveUsersCount = () => {
  const now = Date.now();
  let count = 0;
  for (const [ip, lastSeen] of activeIps.entries()) {
    if (now - lastSeen < 60000) { // Active if seen in last 60 seconds
      count++;
    } else {
      activeIps.delete(ip);
    }
  }
  return count;
};

// Prevent memory leak by cleaning up old IPs every 2 minutes
setInterval(() => {
  global.getActiveUsersCount();
}, 120000);

// Health check / keep-alive ping endpoint
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const token = req.query.ptoken; // Proxy token
  
  if (!targetUrl) return res.status(400).send('URL required');
  
  // Server Kill Switch Check
  if (global.serverStatus === 'offline') {
    return res.status(403).send('SERVER_OFFLINE');
  }

  // Track Active Users
  const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (userIP) {
    activeIps.set(userIP, Date.now());
  }

  // Basic Anti-Theft: Require a static secret token from the frontend
  if (token !== 'kriya_secure_play_2026') {
    return res.status(403).send('Forbidden: Invalid Proxy Token. Hotlinking is not allowed.');
  }

  try {
    // Dynamically choose responseType: stream for video chunks, arraybuffer for playlists
    const isSegment = targetUrl.match(/\.(ts|mp4|m4s|aac)$/i);
    const reqResponseType = isSegment ? 'stream' : 'arraybuffer';

    const response = await axios({
      url: targetUrl,
      method: 'GET',
      responseType: reqResponseType,
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

    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegURL') ||
      targetUrl.includes('.m3u8');

    if (isPlaylist) {
      let text = response.data.toString('utf8');
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';

        if (trimmed.startsWith('#')) {
          return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
            const abs = toAbsoluteUrl(uri, baseUrl, targetUrl);
            return `URI="/proxy?url=${encodeURIComponent(abs)}&ptoken=${token}"`;
          });
        }

        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          return `/proxy?url=${encodeURIComponent(trimmed)}&ptoken=${token}`;
        }

        if (!trimmed.startsWith('#')) {
          const abs = toAbsoluteUrl(trimmed, baseUrl, targetUrl);
          return `/proxy?url=${encodeURIComponent(abs)}&ptoken=${token}`;
        }

        return trimmed;
      }).join('\n');

      return res.send(rewritten);
    }

    if (reqResponseType === 'stream') {
      response.data.pipe(res);
    } else {
      res.send(response.data);
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

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
