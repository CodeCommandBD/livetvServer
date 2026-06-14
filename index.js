require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const crypto = require('crypto');

const TOKEN_SECRET = process.env.PROXY_TOKEN_SECRET || 'nexplay_dynamic_secret_key_2026';

// Connect to MongoDB
connectDB();

const app = express();

// Helmet Security Headers (Disabling CSP since it is a pure backend API proxy)
app.use(helmet({ contentSecurityPolicy: false }));
app.disable('x-powered-by');

// Rate Limiting on proxy: Max 300 requests per minute per IP to prevent spamming
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  },
  handler: (req, res) => res.status(429).send('Too many requests'),
});

const allowedOrigins = [
  'https://nexplay-tv.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost') || origin.startsWith('http://192.168.')) {
      return callback(null, true);
    }
    return callback(new Error('CORS policy violation'), false);
  },
  credentials: true
}));
// SECURITY: Limit request body to 100KB to prevent JSON body DoS attacks
// Without this, an attacker can POST a 500MB JSON payload, crashing the Node process
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost') || origin.startsWith('http://192.168.')) {
        return callback(null, true);
      }
      return callback(new Error('CORS policy violation'), false);
    },
    methods: ["GET", "POST"]
  }
});

const Channel = require('./models/Channel');

// Reaction Batch Buffer
const reactionBuffer = {};

// Watch Party Users Tracker: socket.id -> { partyId, nickname }
const partyUsers = new Map();

io.on('connection', (socket) => {
  socket.on('join_channel', (channelName) => {
    // Leave all previous rooms except the default socket.id room
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });
    socket.join(channelName);
    
    // Architecturally track active viewing sessions for the Auto Link Checker
    global.activeSessions.set(socket.id, { 
      channelName, 
      ip: socket.handshake.address,
      lastSeen: Date.now() 
    });
  });
  
  socket.on('send_reaction', (data) => {
    // CRITICAL SECURITY FIX: Broadcast Amplification DoS Protection
    // Validate inputs to prevent attackers from sending 50MB strings as emojis,
    // which would crash all connected users' browsers and consume massive server bandwidth.
    if (!data || typeof data !== 'object') return;
    if (!data.channelName || typeof data.channelName !== 'string' || data.channelName.length > 150) return;
    if (!data.emoji || typeof data.emoji !== 'string' || data.emoji.length > 20) return;

    socket.to(data.channelName).emit('receive_reaction', data.emoji);
    
    // CRITICAL SECURITY FIX: Memory Exhaustion DoS Protection
    // Prevent an attacker from sending reactions to 1 million fake channel names,
    // which would crash the Node.js RAM and MongoDB bulkWrite.
    if (Object.keys(reactionBuffer).length < 2000) {
      reactionBuffer[data.channelName] = (reactionBuffer[data.channelName] || 0) + 1;
    }
  });

  // ============================
  // WATCH PARTY SOCKET LOGIC
  // ============================
  
  socket.on('join_party', ({ partyId, nickname }) => {
    if (!partyId || !nickname || nickname.length > 50) return;
    
    // CRITICAL LOGICAL FIX: Chat Spillage Prevention
    // If a user switches parties, they must leave the old room first to stop receiving old chats
    const prevUser = partyUsers.get(socket.id);
    if (prevUser && prevUser.partyId !== partyId) {
      const oldRoom = `party_${prevUser.partyId}`;
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('party_notification', {
        type: 'leave',
        message: `${prevUser.nickname} left the party.`,
        timestamp: Date.now()
      });
    }
    
    const roomName = `party_${partyId}`;
    socket.join(roomName);
    
    partyUsers.set(socket.id, { partyId, nickname });
    
    // Notify others in the party
    socket.to(roomName).emit('party_notification', {
      type: 'join',
      message: `${nickname} joined the party!`,
      timestamp: Date.now()
    });
  });

  socket.on('send_party_chat', ({ message }) => {
    // CRITICAL SECURITY FIX: Chat Spoofing & Unauthorized Broadcast
    // Never trust client-provided partyId or nickname for chat messages.
    // Fetch them from the secure server-side Map to ensure the user is actually in the party!
    const user = partyUsers.get(socket.id);
    if (!user || !message || message.length > 500) return;
    
    const roomName = `party_${user.partyId}`;
    // Broadcast to everyone in the room EXCEPT sender
    socket.to(roomName).emit('receive_party_chat', {
      nickname: user.nickname,
      message,
      timestamp: Date.now()
    });
  });

  socket.on('leave_party', () => {
    const user = partyUsers.get(socket.id);
    if (user) {
      const roomName = `party_${user.partyId}`;
      socket.leave(roomName);
      socket.to(roomName).emit('party_notification', {
        type: 'leave',
        message: `${user.nickname} left the party.`,
        timestamp: Date.now()
      });
      partyUsers.delete(socket.id);
    }
  });

  socket.on('disconnect', () => {
    const user = partyUsers.get(socket.id);
    if (user) {
      const roomName = `party_${user.partyId}`;
      socket.to(roomName).emit('party_notification', {
        type: 'leave',
        message: `${user.nickname} left the party.`,
        timestamp: Date.now()
      });
      partyUsers.delete(socket.id);
    }
    
    // Cleanup active session
    global.activeSessions.delete(socket.id);
  });
});

// Mount the Full-Stack API
app.use('/api', require('./api'));

// Initialize Background Automation Engine
const { initCronJobs } = require('./cron');
initCronJobs();

// Batch save reactions every 30 seconds to prevent DB overload
setInterval(async () => {
  const channelsToUpdate = Object.keys(reactionBuffer);
  if (channelsToUpdate.length === 0) return;

  // ✅ Fix Data Loss Bug: Create a snapshot and delete from main buffer immediately
  // to avoid missing new incoming reactions while we process this batch.
  const snapshot = {};
  channelsToUpdate.forEach(channelName => {
    snapshot[channelName] = reactionBuffer[channelName];
    delete reactionBuffer[channelName];
  });

  const bulkOps = Object.keys(snapshot).map(channelName => {
    return {
      updateOne: {
        filter: { name: channelName },
        update: { $inc: { reactionsCount: snapshot[channelName] } }
      }
    };
  });

  try {
    if (bulkOps.length > 0) {
      await Channel.bulkWrite(bulkOps);
    }
  } catch (error) {
    console.error('[Error] Bulk writing reactions:', error.message);
    // ✅ If DB write fails, RESTORE the counts back to the main buffer so they aren't lost
    Object.keys(snapshot).forEach(channelName => {
      reactionBuffer[channelName] = (reactionBuffer[channelName] || 0) + snapshot[channelName];
    });
  }
}, 30000);

// Global State for Kill Switch
global.serverStatus = 'online';
const activeIps = new Map();
global.activeSessions = new Map(); // IP -> { channelName, lastSeen }
global.ipLocationCache = new Map(); // IP -> 'Dhaka'

global.getActiveUsersCount = () => {
  const now = Date.now();
  
  for (const [ip, lastSeen] of activeIps.entries()) {
    if (now - lastSeen > 60000) { 
      activeIps.delete(ip);
    }
  }

  // Cleanup inactive channel sessions (timeout 90s to prevent background tab throttling drops)
  if (global.activeSessions) {
    for (const [ip, session] of global.activeSessions.entries()) {
      if (now - session.lastSeen > 90000) {
        global.activeSessions.delete(ip);
      }
    }
  }

  // Combine unique IPs from both trackers
  const uniqueIps = new Set();
  if (global.activeSessions) {
    for (const session of global.activeSessions.values()) uniqueIps.add(session.ip);
  }
  for (const ip of activeIps.keys()) uniqueIps.add(ip);

  // Cleanup inactive IP locations
  if (global.ipLocationCache) {
    for (const [ip] of global.ipLocationCache.entries()) {
      if (!uniqueIps.has(ip)) {
        global.ipLocationCache.delete(ip);
      }
    }
  }

  return uniqueIps.size;
};

global.getObfuscatedUserCount = () => {
  const real = global.getActiveUsersCount();
  if (real === 0) return 0;
  // ±15% random noise, minimum 1
  const noise = 0.85 + Math.random() * 0.30;
  return Math.max(1, Math.round(real * noise));
};

global.getChannelBreakdown = () => {
  const breakdown = {};
  for (const [clientId, session] of global.activeSessions.entries()) {
    if (!breakdown[session.channelName]) {
      breakdown[session.channelName] = { count: 0, ips: [] };
    }
    breakdown[session.channelName].count++;
    
    // Format IP for display (e.g. ::ffff:192.168.1.1 -> 192.168.1.1)
    const ip = session.ip || 'Unknown';
    const displayIp = ip.replace(/^.*:/, '');
    const location = global.ipLocationCache && global.ipLocationCache.get(ip);
    const ipStr = location && location !== 'Unknown' && location !== 'Fetching...' ? `${displayIp} (${location})` : displayIp;
    
    breakdown[session.channelName].ips.push(ipStr);
  }
  return Object.entries(breakdown)
    .map(([name, data]) => ({ name, count: data.count, ips: data.ips }))
    .sort((a, b) => b.count - a.count);
};

// Prevent memory leak by cleaning up old IPs every 2 minutes
setInterval(() => {
  global.getActiveUsersCount();
}, 120000);

// Health check / keep-alive ping endpoint
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Deep Architecture: Dynamic Stream Token Generation
app.get('/api/stream-token', (req, res) => {
  // Generate a token valid for 3 hours (Better for Football/T20 matches)
  const expiresAt = Date.now() + 3 * 60 * 60 * 1000;
  const hash = crypto.createHmac('sha256', TOKEN_SECRET).update(expiresAt.toString()).digest('hex');
  const token = `${expiresAt}.${hash}`;
  res.json({ token });
});

// LOGICAL FIX: Connection Multiplexing Agents (Anti-Block Architecture)
// Instead of creating a new TCP socket for every video chunk, we keep a pool of open sockets.
// This prevents upstream servers (like Bein Sports) from banning our IP due to rapid socket creation.
// Added socket timeout of 15s to automatically release hung/silent sockets.
const keepAliveAgentHttp = new http.Agent({ 
  keepAlive: true, 
  maxSockets: Infinity, 
  keepAliveMsecs: 30000,
  timeout: 15000 
});
const keepAliveAgentHttps = new https.Agent({ 
  keepAlive: true, 
  maxSockets: Infinity, 
  keepAliveMsecs: 30000,
  timeout: 15000 
});

// LOGICAL FIX: Proxy Deduplication & Caching
// Prevents upstream IPTV servers from banning our IP when multiple users
// watch the same channel. We cache playlists (.m3u8) with jitter and chunks (.ts).
const proxyCache = new Map(); // url -> { data: Buffer|String, expires: number, contentType: string }
let proxyCacheBytes = 0;
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB hard limit for RAM to prevent OOM crashes
const proxyInFlight = new Map(); // url -> Promise<{ data, contentType }>

// BYPASS DETECTOR ARCHITECTURE: Domain Cookie Jar
// Keeps track of cookies set by each upstream domain so we can send them back on subsequent requests.
// This simulates a real web browser session and bypasses cookie-based security checks (like Cloudflare/Bein Sports).
const domainCookies = new Map(); // hostname -> cookie string

// LOGICAL FIX: Proxy Cache Garbage Collector
// Chunks that are never requested again must be actively deleted from RAM,
// otherwise the Node.js process will eventually run out of memory (OOM) and crash.
setInterval(() => {
  const now = Date.now();
  for (const [url, cached] of proxyCache.entries()) {
    if (now > cached.expires) {
      proxyCacheBytes -= (cached.data.length || 0);
      proxyCache.delete(url);
    }
  }
}, 5000); // Check every 5 seconds to aggressively free RAM

app.get('/proxy', proxyLimiter, async (req, res) => {
  let targetUrl = req.query.url;
  const token = req.query.ptoken; // Proxy token
  
  // CRITICAL SECURITY FIX: Query Parameter Type Injection DoS Protection
  // If an attacker sends ?url=a&url=b, targetUrl becomes an Array instead of a String.
  // This causes targetUrl.substring() in the catch block to throw an Uncaught Exception,
  // instantly crashing the entire Node.js server! We MUST ensure it is a string.
  if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).send('Valid URL string required');

  // Strip dead/third-party CORS proxies from the URL
  // Our backend proxy doesn't need them and they often cause 502 Bad Gateway errors
  if (targetUrl.startsWith('https://cors-proxy.cooks.fyi/')) {
    targetUrl = targetUrl.replace('https://cors-proxy.cooks.fyi/', '');
  }
  
  // Server Kill Switch Check
  if (global.serverStatus === 'offline') {
    return res.status(403).send('SERVER_OFFLINE');
  }

  // Track Active Users
  const forwardedFor = req.headers['x-forwarded-for'];
  const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;
  if (userIP) {
    activeIps.set(userIP, Date.now());
  }

  // Deep Architecture Fix: Dynamic Token Verification (HMAC-SHA256)
  if (!token || !token.includes('.')) {
    return res.status(403).send('Forbidden: Invalid or missing token format.');
  }
  
  const [timestamp, hash] = token.split('.');
  if (Date.now() > parseInt(timestamp, 10)) {
    return res.status(403).send('Forbidden: Token has expired. Please refresh the page.');
  }
  
  const expectedHash = crypto.createHmac('sha256', TOKEN_SECRET).update(timestamp).digest('hex');
  if (hash !== expectedHash) {
    return res.status(403).send('Forbidden: Invalid Token Signature. Hotlinking blocked.');
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const hostname = parsedUrl.hostname;

    if (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
      hostname === '0.0.0.0' || hostname === '::' || hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') || hostname.startsWith('169.254.') || hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
    ) {
      return res.status(403).send('Forbidden: Internal IPs blocked.');
    }

    const isPlaylistUrl = targetUrl.includes('.m3u8') || targetUrl.includes('mpegurl');
    const isChunkUrl = targetUrl.includes('.ts') || targetUrl.includes('.m4s') || targetUrl.includes('.vtt');
    const hasRange = !!req.headers['range'];

    // 1. Check Cache
    // Deep Architecture Fix: BYPASS cache for Range requests to prevent cross-user data corruption
    if (!hasRange && proxyCache.has(targetUrl)) {
      const cached = proxyCache.get(targetUrl);
      if (Date.now() < cached.expires) {
        res.set('Content-Type', cached.contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=2'); // Help browser cache chunks too
        return res.send(cached.data);
      } else {
        proxyCache.delete(targetUrl);
      }
    }

    // 2. Check In-Flight Deduplication
    // If another user is CURRENTLY downloading this exact file, wait for their promise!
    if (!hasRange && proxyInFlight.has(targetUrl)) {
      try {
        const result = await proxyInFlight.get(targetUrl);
        res.set('Content-Type', result.contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=2');
        return res.send(result.data);
      } catch (err) {
        console.warn(`[Proxy] In-flight deduplication failed for ${targetUrl.substring(0, 50)}... falling through to retry:`, err.message);
      }
    }

    // 3. We are the first! Start the fetch.
    const fetchPromise = (async () => {
      const controller = new AbortController();
      // Strict 15s timeout for downloading anything (prevents hanging sockets)
      const timeoutId = setTimeout(() => controller.abort(), 15000); 

      // CRITICAL ARCHITECTURAL FIX: Bandwidth & Memory Leak Prevention
      // If the user's browser disconnects midway through downloading a chunk,
      // abort the upstream Axios request immediately to save Server RAM & Bandwidth.
      const onClientDisconnect = () => controller.abort();
      req.on('close', onClientDisconnect);

      try {
        const parsedTarget = new URL(targetUrl);
        const targetDomain = parsedTarget.origin;
        const targetHostname = parsedTarget.hostname;

        // Retrieve saved cookies for this host to bypass security checks
        const savedCookies = domainCookies.get(targetHostname);

        const requestHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'keep-alive',
          'Referer': targetDomain + '/',
          'Origin': targetDomain,
          'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site'
        };

        // Deep Architecture Fix: Forward HTTP Range Header for DASH Seeking
        // Without this, the proxy will download the entire 5GB file instead of 1KB chunk!
        if (req.headers['range']) {
          requestHeaders['Range'] = req.headers['range'];
        }

        if (savedCookies) {
          requestHeaders['Cookie'] = savedCookies;
        }

        const response = await axios({
          url: targetUrl,
          method: 'GET',
          signal: controller.signal,
          responseType: 'stream', // ALWAYS stream to enforce memory limits manually
          httpAgent: keepAliveAgentHttp,
          httpsAgent: keepAliveAgentHttps,
          headers: requestHeaders,
          timeout: 12000,
        });

        // ✅ Stream Error Listener: Prevent process crash on stream errors
        response.data.on('error', (err) => {
          console.error(`[Stream Error] Stream emitted error for ${targetUrl.substring(0, 60)}:`, err.message);
        });

        const contentType = response.headers['content-type'] || '';
        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        const finalUrl = response.request?.res?.responseUrl || targetUrl;
        const statusCode = response.status;
        const contentRange = response.headers['content-range'];
        const acceptRanges = response.headers['accept-ranges'];

        const isPlaylist = isPlaylistUrl || contentType.includes('mpegurl') || contentType.includes('x-mpegURL');
        const isManifest = isPlaylist || targetUrl.includes('.mpd') || contentType.includes('dash+xml');

        // Store cookies if the upstream server sets them
        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
          const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
          // Fix 3: Prevent memory leak in domainCookies Map
          if (domainCookies.size >= 500) {
            const oldestKey = domainCookies.keys().next().value;
            domainCookies.delete(oldestKey);
          }
          domainCookies.set(targetHostname, cookieStr);
        }

        // CRITICAL LOGICAL FIX: OOM Protection & 100% Caching
        // Buffer everything up to 20MB limit
        if (contentLength > 20 * 1024 * 1024) {
          response.data.destroy();
          throw new Error('File explicitly exceeds 20MB limit');
        }

        const chunks = [];
        let totalSize = 0;
        for await (const chunk of response.data) {
          totalSize += chunk.length;
          if (totalSize > 20 * 1024 * 1024) { // 20MB hard limit (protects against infinite streams)
            response.data.destroy();
            throw new Error('Stream exceeded 20MB buffer limit');
          }
          chunks.push(chunk);
        }
        
        const buffer = Buffer.concat(chunks);

        if (isPlaylist) {
          const text = buffer.toString('utf8');
          const rewritten = text.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('#')) {
              return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
                const abs = toAbsoluteUrl(uri, finalUrl);
                return `URI="/proxy?url=${encodeURIComponent(abs)}&ptoken=${token}"`;
              });
            }
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
              return `/proxy?url=${encodeURIComponent(trimmed)}&ptoken=${token}`;
            }
            if (!trimmed.startsWith('#')) {
              const abs = toAbsoluteUrl(trimmed, finalUrl);
              return `/proxy?url=${encodeURIComponent(abs)}&ptoken=${token}`;
            }
            return trimmed;
          }).join('\n');

          return { data: rewritten, contentType, isPlaylist: true, isManifest: true, statusCode, contentRange, acceptRanges };
        }

        // It's a video chunk, key file, or XML manifest
        return { data: buffer, contentType, isPlaylist: false, isManifest, statusCode, contentRange, acceptRanges };
      } finally {
        // ✅ Ensure the timeout is cleared ONLY after the stream download finishes or fails
        clearTimeout(timeoutId);
        // Remove the close listener to avoid memory leaks on the request object
        req.off('close', onClientDisconnect);
      }
    })();

    // Store in-flight for EVERYTHING to guarantee deduplication
    if (!hasRange) {
      proxyInFlight.set(targetUrl, fetchPromise);
    }

    let result;
    try {
      result = await fetchPromise;
    } finally {
      proxyInFlight.delete(targetUrl);
    }

    res.set('Content-Type', result.contentType);
    res.set('Access-Control-Allow-Origin', '*');
    if (result.acceptRanges) res.set('Accept-Ranges', result.acceptRanges);
    if (result.contentRange) res.set('Content-Range', result.contentRange);

    // For Playlists & Chunks, save to cache
    // Playlist cache gets a small random jitter (3000ms - 4000ms) to look natural/organic to upstream anti-bot systems
    if (!hasRange) {
      const cacheTtl = result.isManifest ? (3000 + Math.floor(Math.random() * 1000)) : 15000; // 3-4s for manifests, 15s for chunks
      
      if (proxyCache.has(targetUrl)) {
        proxyCacheBytes -= (proxyCache.get(targetUrl).data.length || 0);
      }

      proxyCache.set(targetUrl, {
        data: result.data,
        contentType: result.contentType,
        expires: Date.now() + cacheTtl
      });
      proxyCacheBytes += (result.data.length || 0);
    }

    // Strict RAM Limit Enforcement: Delete oldest chunks if we exceed 100MB
    while (proxyCacheBytes > MAX_CACHE_BYTES && proxyCache.size > 0) {
      const oldestKey = proxyCache.keys().next().value;
      if (oldestKey) {
        proxyCacheBytes -= (proxyCache.get(oldestKey).data.length || 0);
        proxyCache.delete(oldestKey);
      }
    }

    res.set('Cache-Control', 'public, max-age=2');
    return res.status(result.statusCode || 200).send(result.data);

  } catch (err) {
    const status = err.response?.status || 502;
    console.error(`[Proxy Error] ${status} — ${targetUrl.substring(0, 80)}`);
    res.status(status).send('Proxy error');
  }
});

function toAbsoluteUrl(uri, full) {
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  try {
    return new URL(uri, full).href;
  } catch {
    // Fallback if URL parsing fails
    const basePath = full.split('?')[0];
    const base = basePath.substring(0, basePath.lastIndexOf('/') + 1);
    if (uri.startsWith('/')) {
       try { return new URL(uri, full).origin + uri; } catch { return uri; }
    }
    return base + uri;
  }
}

// Global Exception Handlers to prevent process crash
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
const PORT = process.env.PORT || 5050;
server.listen(PORT, () => {
  console.log(`Live TV Server running on port ${PORT}`);
});

// CRITICAL ARCHITECTURAL FIX: Global Error Boundary
// Prevent the entire Node.js server from crashing due to unhandled promise rejections
// in background cron jobs or third-party API calls.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Global Error Boundary] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Global Error Boundary] Uncaught Exception:', err);
});
