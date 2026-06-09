require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const connectDB = require('./config/db');

// Connect to MongoDB
connectDB();

const app = express();

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
app.use(express.json());

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
    if (!partyId || !nickname) return;
    
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

  socket.on('send_party_chat', ({ partyId, nickname, message }) => {
    if (!partyId || !nickname || !message || message.length > 500) return;
    
    const roomName = `party_${partyId}`;
    // Broadcast to everyone in the room EXCEPT sender
    socket.to(roomName).emit('receive_party_chat', {
      nickname,
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

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const token = req.query.ptoken; // Proxy token
  
  // CRITICAL SECURITY FIX: Query Parameter Type Injection DoS Protection
  // If an attacker sends ?url=a&url=b, targetUrl becomes an Array instead of a String.
  // This causes targetUrl.substring() in the catch block to throw an Uncaught Exception,
  // instantly crashing the entire Node.js server! We MUST ensure it is a string.
  if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).send('Valid URL string required');
  
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

  // Basic Anti-Theft: Require a static secret token from the frontend
  if (token !== 'nexplay_secure_play_2026') {
    return res.status(403).send('Forbidden: Invalid Proxy Token. Hotlinking is not allowed.');
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const hostname = parsedUrl.hostname;

    // CRITICAL SECURITY FIX: Server-Side Request Forgery (SSRF) Protection
    // Block attackers from using the proxy to scan internal network ports, 
    // access local services, or steal cloud metadata (like AWS IAM keys at 169.254.169.254)
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('169.254.') ||
      hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
    ) {
      return res.status(403).send('Forbidden: Internal IP addresses are blocked (SSRF Protection).');
    }

    // ALWAYS use stream to prevent massive RAM spikes.
    // We will dynamically check Content-Type headers after connecting to decide 
    // whether to parse it as a playlist or pipe it directly as a video segment.
    const response = await axios({
      url: targetUrl,
      method: 'GET',
      responseType: 'stream',
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

    // CRITICAL FIX: Handle Load Balancer Redirects!
    // If the IPTV provider redirects from http://a.com/live to http://b.com/live.m3u8
    // we MUST use the final URL (http://b.com) to resolve relative chunks inside the playlist!
    // Otherwise, the proxy will request chunks from the original domain and get 404s.
    const finalUrl = response.request?.res?.responseUrl || targetUrl;

    const isPlaylist =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegURL') ||
      finalUrl.includes('.m3u8');

    if (isPlaylist) {
      // CRITICAL SECURITY FIX: Playlist Buffer Overflow Protection
      // Prevent malicious servers from sending gigabytes of fake playlist data
      // which would crash the Node.js V8 memory limit (Max String Size)
      let text = '';
      let totalSize = 0;
      for await (const chunk of response.data) {
        totalSize += chunk.length;
        if (totalSize > 5 * 1024 * 1024) { // 5MB Limit for a text playlist
          response.data.destroy();
          console.error(`[Proxy] Playlist exceeded 5MB limit: ${targetUrl}`);
          return res.status(413).send('Payload Too Large: Playlist exceeds size limit.');
        }
        text += chunk.toString('utf8');
      }

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

      return res.send(rewritten);
    }

    // It's a video segment (or unknown binary). Pipe it directly to save RAM!
    response.data.pipe(res);

      // CRITICAL FIX: Memory Leak Prevention
      // If the client disconnects (closes the browser/player) while a video chunk is downloading,
      // we MUST destroy the Axios stream. Otherwise, the proxy will keep downloading the rest of the 
      // chunk from the IPTV server into oblivion, wasting massive bandwidth and RAM!
      res.on('close', () => {
        if (!res.writableEnded && response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      });
      res.on('error', () => {
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy();
        }
      });

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

const PORT = process.env.PORT || 5050;
server.listen(PORT, () => {
  console.log(`Proxy & Socket server running on port ${PORT}`);
});
