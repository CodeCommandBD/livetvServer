const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const Admin = require('./models/Admin');
const Channel = require('./models/Channel');
const Audit = require('./models/Audit');
const Match = require('./models/Match');
const Setting = require('./models/Setting');
const Contact = require('./models/Contact');
const SyncSource = require('./models/SyncSource');
const { syncFromGitHub, checkLinks } = require('./cron');
const redis = require('./config/redis');

// We use the same JWT Secret from .env or fallback
const JWT_SECRET = process.env.JWT_SECRET || 'nexplay_tv_super_secret_admin_key_2026';
if (!process.env.JWT_SECRET) {
  console.warn('[SECURITY WARNING] JWT_SECRET is not set in .env! Using insecure fallback key. Set a strong JWT_SECRET in production!');
}

// Middleware to verify JWT
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========================
// AUTHENTICATION
// ========================

// Brute-Force Protection: Track failed login attempts per IP
const loginAttempts = new Map();

router.post('/admin/login', async (req, res) => {
  try {
    const forwardedFor = req.headers['x-forwarded-for'];
    const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;

    // Block IP after 10 failed attempts in 15 minutes
    const attempt = loginAttempts.get(userIP) || { count: 0, time: Date.now() };
    if (Date.now() - attempt.time > 15 * 60 * 1000) {
      attempt.count = 0;
      attempt.time = Date.now();
    }
    if (attempt.count >= 10) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }

    const { username, password } = req.body;

    // ✅ Fix Logic Error: Prevent bcrypt.compare crash if password is missing
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const admin = await Admin.findOne({ username });

    if (!admin) {
      attempt.count++;
      loginAttempts.set(userIP, attempt);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      attempt.count++;
      loginAttempts.set(userIP, attempt);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Successful login — reset attempt counter
    loginAttempts.delete(userIP);
    const token = jwt.sign({ id: admin._id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// AUTOMATION & TRENDING
// ========================

router.get('/trending', async (req, res) => {
  try {
    if (redis) {
      try {
        const cachedTrending = await redis.get('nexplaytv:trending');
        if (cachedTrending) return res.json(cachedTrending);
      } catch (redisErr) {
        console.error('Redis GET error (trending):', redisErr.message);
        // Do not throw, gracefully fallback to MongoDB
      }
    }

    // Calculate trending based on PLAY_START in last 24h using aggregation
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const trendingList = await Audit.aggregate([
      { $match: { type: 'PLAY_START', timestamp: { $gte: twentyFourHoursAgo } } },
      { $group: { _id: "$channel", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 4 }
    ]);

    const trendingNames = trendingList.map(t => t._id);
    
    // Fetch actual channels
    const channels = await Channel.find({ name: { $in: trendingNames } });
    
    // Sort channels by the trending order
    const sortedChannels = trendingNames.map(name => channels.find(c => c.name === name)).filter(Boolean);
    
    if (redis) {
      try {
        await redis.set('nexplaytv:trending', sortedChannels, { ex: 300 }); // Cache for 5 mins
      } catch (redisErr) {
        console.error('Redis SET error (trending):', redisErr.message);
      }
    }
    res.json(sortedChannels);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

global.automationStatus = {
  isSyncing: false,
  isChecking: false,
  syncMessage: null,
  checkMessage: null
};

router.get('/automation/status', authenticate, (req, res) => {
  res.json(global.automationStatus);
});

router.post('/automation/sync', authenticate, async (req, res) => {
  try {
    if (global.automationStatus.isSyncing) return res.json({ success: true, message: 'Already syncing' });
    
    global.automationStatus.isSyncing = true;
    global.automationStatus.syncMessage = null;
    
    // Run in background
    syncFromGitHub().then(result => {
      global.automationStatus.isSyncing = false;
      if (result) {
        global.automationStatus.syncMessage = `Success! Added ${result.addedCount} new channels, updated ${result.updatedCount} expired tokens.`;
      } else {
        global.automationStatus.syncMessage = 'Failed to sync. Please check server logs.';
      }
    }).catch(err => {
      global.automationStatus.isSyncing = false;
      global.automationStatus.syncMessage = 'Failed to sync: ' + err.message;
    });

    res.json({ success: true, message: 'Sync started' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/automation/check-links', authenticate, async (req, res) => {
  try {
    if (global.automationStatus.isChecking) return res.json({ success: true, message: 'Already checking' });
    
    global.automationStatus.isChecking = true;
    global.automationStatus.checkMessage = null;
    
    // Run in background
    checkLinks().then(result => {
      global.automationStatus.isChecking = false;
      if (result) {
        global.automationStatus.checkMessage = `Success! Checked ${result.checked} random channels, found and disabled ${result.deadCount} dead links.`;
      } else {
        global.automationStatus.checkMessage = 'Failed to run link checker. Please check server logs.';
      }
    }).catch(err => {
      global.automationStatus.isChecking = false;
      global.automationStatus.checkMessage = 'Failed to run check: ' + err.message;
    });

    res.json({ success: true, message: 'Check started' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// SYNC SOURCES CRUD
// ========================

// GET all sync sources
router.get('/sync-sources', authenticate, async (req, res) => {
  try {
    const sources = await SyncSource.find({}).sort({ createdAt: -1 });
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST — add a new sync source
router.post('/sync-sources', authenticate, async (req, res) => {
  try {
    const { name, url, type } = req.body;
    if (!name || !url || !type) {
      return res.status(400).json({ error: 'name, url, and type are required.' });
    }
    if (!['json', 'm3u'].includes(type)) {
      return res.status(400).json({ error: 'type must be "json" or "m3u".' });
    }
    const source = new SyncSource({ name: name.trim(), url: url.trim(), type });
    await source.save();
    res.status(201).json(source);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This URL already exists in Sync Sources.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT — update a sync source (enabled, name, url, type)
router.put('/sync-sources/:id', authenticate, async (req, res) => {
  try {
    const { enabled, name, url, type } = req.body;
    
    // Build update object dynamically
    const updateData = {};
    if (typeof enabled === 'boolean') updateData.enabled = enabled;
    if (name) updateData.name = name.trim();
    if (url) updateData.url = url.trim();
    if (type && ['json', 'm3u'].includes(type)) updateData.type = type;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const source = await SyncSource.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
    if (!source) return res.status(404).json({ error: 'Source not found.' });
    res.json(source);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This URL already exists in Sync Sources.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE — remove a sync source
router.delete('/sync-sources/:id', authenticate, async (req, res) => {
  try {
    const source = await SyncSource.findByIdAndDelete(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// MATCHES (Live & Upcoming)
// ========================

let matchClients = [];

const notifyMatchUpdate = () => {
  matchClients.forEach(client => {
    try {
      // ✅ Fix Logic Error: Prevent ERR_STREAM_WRITE_AFTER_END server crash
      if (!client.writableEnded) {
        client.write(`data: update\n\n`);
      }
    } catch (err) {
      // Safely ignore write errors to disconnected clients
    }
  });
};
global.notifyMatchUpdate = notifyMatchUpdate;

router.get('/matches/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // SECURITY: Cap the number of SSE clients to prevent memory exhaustion
  // Without this, an attacker could open 100,000 long-lived SSE connections to exhaust RAM
  if (matchClients.length >= 2000) {
    res.status(503).json({ error: 'Too many live connections' });
    return;
  }

  // Send initial heartbeat
  res.write(`data: connected\n\n`);

  matchClients.push(res);

  // Send a keep-alive comment every 30 seconds to prevent reverse proxies (Render/Nginx)
  // from closing the connection due to idle timeout!
  const keepAliveId = setInterval(() => {
    try {
      // ✅ Prevent crash on ungraceful disconnect
      if (!res.writableEnded) {
        res.write(`:\n\n`); 
      } else {
        clearInterval(keepAliveId);
      }
    } catch (err) {
      clearInterval(keepAliveId);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAliveId);
    matchClients = matchClients.filter(c => c !== res);
  });
});

router.get('/matches', async (req, res) => {
  try {
    const query = req.query.all === 'true' ? {} : { status: { $ne: 'ENDED' } };
    // LOGICAL FIX: Cap at 500 to prevent OOM crash if there are thousands of historical matches
    const limit = req.query.all === 'true' ? 500 : 0; 
    const sortOrder = req.query.all === 'true' ? -1 : 1;
    const matches = await Match.find(query).sort({ startTime: sortOrder }).limit(limit);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/admin/matches', authenticate, async (req, res) => {
  try {
    const { sport, status, startTime, team1, team2, channelName } = req.body;

    // LOGICAL FIX: Input validation — prevent blank/malformed matches from being saved
    if (!sport || !startTime || !team1?.name || !team2?.name || !channelName) {
      return res.status(400).json({ error: 'Missing required fields: sport, startTime, team1.name, team2.name, channelName' });
    }
    // SECURITY: Validate flag URLs to prevent SSRF via flagUrl field
    const allowedFlagHosts = ['flagcdn.com', 'upload.wikimedia.org', 'logos-world.net', 'img.icons8.com'];
    const isSafeFlagUrl = (url) => {
      if (!url) return true; // Optional field, empty is fine
      try { return allowedFlagHosts.some(h => new URL(url).hostname.endsWith(h)); }
      catch { return false; }
    };
    if (!isSafeFlagUrl(team1.flagUrl) || !isSafeFlagUrl(team2.flagUrl)) {
      return res.status(400).json({ error: 'Invalid flag URL. Only trusted image hosts are allowed.' });
    }
    // Sanitize text field lengths
    if (team1.name.length > 100 || team2.name.length > 100 || channelName.length > 200) {
      return res.status(400).json({ error: 'Field too long.' });
    }

    const match = new Match(req.body);
    await match.save();
    notifyMatchUpdate();
    res.status(201).json(match);
  } catch (err) {
    console.error("Match save error:", err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.put('/admin/matches/:id', authenticate, async (req, res) => {
  try {
    // AUTO-SET liveStartedAt: When admin changes status to LIVE for the first time,
    // record the exact timestamp so the frontend can show an accurate elapsed timer.
    const existingMatch = await Match.findById(req.params.id);
    if (!existingMatch) return res.status(404).json({ error: 'Match not found' });

    const updateData = { ...req.body };

    // If transitioning to LIVE and liveStartedAt not already set, auto-set it now
    if (updateData.status === 'LIVE' && !existingMatch.liveStartedAt) {
      updateData.liveStartedAt = new Date();
    }
    // If transitioning away from LIVE (e.g., ENDED), keep liveStartedAt for history

    // CRITICAL LOGICAL FIX: Use $set for partial updates.
    // Previously `updateData` was passed directly, so `runValidators: true` would
    // validate ALL schema fields \u2014 including required ones NOT present in a partial
    // update (e.g. a score-only update). This caused a Mongoose ValidationError crash
    // every time the admin clicked the \u26bd goal +/- button on the frontend.
    // Wrapping in $set tells Mongoose to only validate the fields being changed.
    const match = await Match.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
    notifyMatchUpdate();
    res.json(match);
  } catch (err) {
    console.error("Match update error:", err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});


router.delete('/admin/matches/:id', authenticate, async (req, res) => {
  try {
    const match = await Match.findByIdAndDelete(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    notifyMatchUpdate();
    res.json({ message: 'Match deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// HOME SECTIONS (Admin Layout Manager)
// ========================

router.get('/home-sections', async (req, res) => {
  try {
    if (redis) {
      try {
        const cachedSections = await redis.get('nexplaytv:homeSections');
        if (cachedSections) return res.json(cachedSections);
      } catch (redisErr) {
        console.error('Redis GET error (homeSections):', redisErr.message);
      }
    }
    const setting = await Setting.findOne({ key: 'homeSections' });
    const defaultSections = { cricket: [], football: [], watchRecommended: [], watchFootball: [], watchCricket: [] };
    const sections = setting ? { ...defaultSections, ...setting.value } : defaultSections;
    if (redis) {
      try {
        await redis.set('nexplaytv:homeSections', sections, { ex: 3600 }); // Cache for 1 hour
      } catch (redisErr) {}
    }
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/home-sections', authenticate, async (req, res) => {
  try {
    const updated = await Setting.findOneAndUpdate(
      { key: 'homeSections' },
      { value: req.body },
      { new: true, upsert: true }
    );
    if (redis) {
      try { await redis.del('nexplaytv:homeSections'); } catch (e) {}
    }
    res.json(updated.value);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// CHANNELS (CRUD)
// ========================

const invalidateCache = async () => {
  if (redis) {
    try {
      await redis.del('nexplaytv:channels');
      await redis.del('nexplaytv:trending');
    } catch (err) {
      console.error('Redis cache invalidation error:', err.message);
    }
  }
};

// Public: Get all channels (for frontend useChannels)
router.get('/channels', async (req, res) => {
  try {
    if (redis) {
      try {
        const cachedChannels = await redis.get('nexplaytv:channels');
        if (cachedChannels) return res.json(cachedChannels);
      } catch (redisErr) {
        console.error('Redis GET error (channels):', redisErr.message);
      }
    }
    
    const channels = await Channel.find().select('-__v');
    
    if (redis) {
      try {
        await redis.set('nexplaytv:channels', channels, { ex: 3600 }); // Cache for 1 hour
      } catch (redisErr) {}
    }
    
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get all channels (Bypass Redis Cache for fresh stats like reactionsCount, supports pagination)
router.get('/admin/channels', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const status = req.query.status || 'all';

    let query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { group: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (status !== 'all') {
      if (status === 'live') {
        query.status = { $ne: 'dead' };
      } else if (status === 'dead') {
        query.status = 'dead';
      }
    }

    const skip = (page - 1) * limit;

    const [channels, total] = await Promise.all([
      Channel.find(query).select('-__v').sort({ _id: -1 }).skip(skip).limit(limit),
      Channel.countDocuments(query)
    ]);

    res.json({
      data: channels,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Add a channel
router.post('/channels', authenticate, async (req, res) => {
  try {
    const channel = new Channel(req.body);
    await channel.save();
    invalidateCache();
    res.status(201).json(channel);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Edit a channel
router.put('/channels/:id', authenticate, async (req, res) => {
  try {
    // Fetch old channel first to check if name changed
    let oldChannel;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      oldChannel = await Channel.findById(req.params.id);
    } else {
      oldChannel = await Channel.findOne({ name: req.params.id });
    }
    
    if (!oldChannel) return res.status(404).json({ error: 'Channel not found' });
    
    const oldName = oldChannel.name;
    const newName = req.body.name;

    // CRITICAL SECURITY FIX: Mongoose Schema Validation Bypass Protection
    // We MUST use runValidators: true to prevent saving empty names or invalid URLs.
    const channel = await Channel.findByIdAndUpdate(oldChannel._id, req.body, { new: true, runValidators: true });
    
    // CRITICAL LOGICAL FIX: Cascading Match Updates
    // If the channel name was changed, update all matches referencing the old name
    if (newName && newName !== oldName) {
      await Match.updateMany({ channelName: oldName }, { $set: { channelName: newName } });
      if (global.notifyMatchUpdate) global.notifyMatchUpdate();
    }
    
    invalidateCache();
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete a channel
router.delete('/channels/:id', authenticate, async (req, res) => {
  try {
    let oldChannel;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      oldChannel = await Channel.findById(req.params.id);
    } else {
      oldChannel = await Channel.findOne({ name: req.params.id });
    }
    
    if (!oldChannel) return res.status(404).json({ error: 'Channel not found' });
    
    await Channel.findByIdAndDelete(oldChannel._id);
    
    // CRITICAL LOGICAL FIX: Dangling Match Reference Cleanup
    // If a channel is deleted, remove all active matches attached to it to prevent frontend crashes
    await Match.deleteMany({ channelName: oldChannel.name, status: { $ne: 'ENDED' } });
    if (global.notifyMatchUpdate) global.notifyMatchUpdate();

    invalidateCache();
    res.json({ message: 'Channel deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// SERVER CONTROL (KILL SWITCH)
// ========================

// Admin: Get Basic Server Status & Viewers
router.get('/admin/server-status', authenticate, async (req, res) => {
  const activeUsers = global.getActiveUsersCount ? global.getActiveUsersCount() : 0;
  const breakdown = global.getChannelBreakdown ? global.getChannelBreakdown() : [];
  res.json({ status: global.serverStatus || 'online', activeUsers, breakdown });
});

// Admin: Set server status
router.put('/admin/server-status', authenticate, async (req, res) => {
  try {
    const { status, force } = req.body;
    const activeUsers = global.getActiveUsersCount ? global.getActiveUsersCount() : 0;
    
    if (status === 'offline' && activeUsers > 0 && !force) {
      return res.status(400).json({ error: 'Cannot turn off server while users are active' });
    }
    
    global.serverStatus = status;
    res.json({ status: global.serverStatus, activeUsers });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// AUDIT & LOGS
// ========================

// Rate Limiter for ip-api to prevent ban/DoS (Max ~40 requests per minute)
global.lastIpFetchTime = 0;
const canFetchIp = () => {
  const now = Date.now();
  if (now - global.lastIpFetchTime > 1500) {
    global.lastIpFetchTime = now;
    return true;
  }
  return false;
};

// Rate Limiter for Audit to prevent DB Flooding & Trending Spoofing
const auditRateLimit = new Map();
// Cache to prevent false view inflation: IP+Channel must wait 15 mins before a new view is counted
const viewDebounceLimit = new Map();

// ✅ LOGICAL FIX: Garbage Collection for Maps to prevent Memory Leaks
setInterval(() => {
  const now = Date.now();
  // Cleanup old login attempts (older than 15 mins)
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (now - attempt.time > 15 * 60 * 1000) {
      loginAttempts.delete(ip);
    }
  }
  // Cleanup old audit rate limits (older than 2 mins)
  for (const [ip, rate] of auditRateLimit.entries()) {
    if (now - rate.time > 120000) {
      auditRateLimit.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// Audit Event Logging
router.post('/audit/event', async (req, res) => {
  try {
    const { type, channel, error } = req.body;
    if (!type || !channel) return res.status(400).json({ error: 'Missing data' });
    
    // Validate length to prevent huge document bloat
    if (typeof channel !== 'string' || channel.length > 200 || typeof type !== 'string' || type.length > 50) {
      return res.status(400).json({ error: 'Payload too large' });
    }

    // Extract IP BEFORE responding
    const forwardedFor = req.headers['x-forwarded-for'];
    const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;

    // Strict Rate Limiting: Max 10 audit events per IP per minute
    if (userIP) {
      const now = Date.now();
      const userRate = auditRateLimit.get(userIP) || { count: 0, time: now };
      if (now - userRate.time > 60000) {
        userRate.count = 1;
        userRate.time = now;
      } else {
        userRate.count++;
      }
      auditRateLimit.set(userIP, userRate);

      if (userRate.count > 15) {
        return res.status(429).json({ error: 'Too many requests' });
      }
    }

    // Respond immediately so the client isn't blocked
    res.json({ success: true });

    // Process asynchronously
    
    // ✅ LOGICAL FIX: Deep Deduplication of PLAY_START
    // Prevent 1 user from generating 100 views by refreshing the page or switching tabs rapidly.
    // An IP can only log 1 view per channel every 15 minutes.
    if (type === 'PLAY_START' && userIP) {
      const viewKey = `${userIP}_${channel}`;
      const lastViewTime = viewDebounceLimit.get(viewKey);
      const now = Date.now();
      
      if (lastViewTime && (now - lastViewTime < 15 * 60 * 1000)) {
        return; // Silently drop duplicate view logic
      }
      viewDebounceLimit.set(viewKey, now);
      
      // Prevent memory leak by occasionally cleaning up old entries
      if (viewDebounceLimit.size > 5000) {
        const oldestAllowed = now - 15 * 60 * 1000;
        for (const [key, time] of viewDebounceLimit.entries()) {
          if (time < oldestAllowed) viewDebounceLimit.delete(key);
        }
      }
    }
    
    let location = 'Unknown Location';
    
    if (userIP) {
      if (userIP === '127.0.0.1' || userIP === '::1' || userIP.startsWith('192.168.')) {
        location = 'Localhost';
      } else if (global.ipLocationCache && global.ipLocationCache.has(userIP)) {
        location = global.ipLocationCache.get(userIP);
      } else if (canFetchIp()) {
        try {
          const axios = require('axios');
          const resp = await axios.get(`http://ip-api.com/json/${userIP}`, { timeout: 2000 });
          if (resp.data && resp.data.status === 'success') {
            location = resp.data.city ? `${resp.data.city}, ${resp.data.country}` : resp.data.country;
            if (!global.ipLocationCache) global.ipLocationCache = new Map();
            global.ipLocationCache.set(userIP, location);
          }
        } catch (e) {
          // Ignore timeout or network errors
        }
      } else {
        location = 'Unknown Location (Rate Limited)';
      }
    }

    const audit = new Audit({ 
      type, 
      channel, 
      error,
      metadata: { ip: userIP, location }
    });
    await audit.save();

  } catch (err) {
    console.error('Audit Error:', err);
  }
});

const axios = require('axios');

// Real-time Channel Tracking Heartbeat
router.post('/stream/heartbeat', (req, res) => {
  const { channelName, clientId } = req.body;
  
  // Validate input types to prevent NoSQL/Logic crashes
  if (typeof channelName !== 'string' || channelName.length > 200 || typeof clientId !== 'string' || clientId.length > 100) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;
  
  if (userIP && channelName && clientId && global.activeSessions) {
    // CRITICAL FIX: Memory Exhaustion (OOM) Protection
    // Prevent attacker from sending millions of fake clientIds and crashing the server RAM
    if (global.activeSessions.size > 50000 && !global.activeSessions.has(clientId)) {
      return res.status(503).json({ error: 'Server at capacity' });
    }

    global.activeSessions.set(clientId, { ip: userIP, channelName, lastSeen: Date.now() });

    // Background fetch for IP location if not cached
    if (global.ipLocationCache && !global.ipLocationCache.has(userIP)) {
      if (userIP === '127.0.0.1' || userIP === '::1' || userIP.startsWith('192.168.')) {
        global.ipLocationCache.set(userIP, 'Localhost');
      } else if (canFetchIp()) {
        global.ipLocationCache.set(userIP, 'Fetching...');
        axios.get(`http://ip-api.com/json/${userIP}`, { timeout: 2000 }).then(resp => {
          if (resp.data && resp.data.status === 'success') {
            const loc = resp.data.city ? `${resp.data.city}, ${resp.data.country}` : resp.data.country;
            global.ipLocationCache.set(userIP, loc);
          } else {
            global.ipLocationCache.delete(userIP); // allow retry
          }
        }).catch(() => {
          global.ipLocationCache.delete(userIP); // allow retry
        });
      }
    }
  }
  
  res.json({ success: true });
});

// Admin: Get dashboard stats
router.get('/admin/stats', authenticate, async (req, res) => {
  try {
    const totalChannels = await Channel.countDocuments();
    const totalViews = await Audit.countDocuments({ type: 'PLAY_START' });
    const totalErrors = await Audit.countDocuments({ type: 'PLAY_ERROR' });

    const deadLinksEstimate = await Channel.countDocuments({ status: 'dead' });

    // Total Reactions across all channels
    const totalReactionsRaw = await Channel.aggregate([{ $group: { _id: null, total: { $sum: "$reactionsCount" } } }]);
    const totalReactions = totalReactionsRaw.length > 0 ? totalReactionsRaw[0].total : 0;

    // Views by day for last 7 days — grouped by BD midnight (Asia/Dhaka = UTC+6)
    // Look back 8 UTC days to guarantee 7 complete BD days are always captured.
    // (BD is UTC+6, so a BD day starts 6hrs before its UTC equivalent — 7 UTC days would cut off the first BD day)
    const sevenDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const viewsByDayRaw = await Audit.aggregate([
      { $match: { type: 'PLAY_START', timestamp: { $gte: sevenDaysAgo } } },
      {
        $group: {
          // ✅ FIX: timezone: "Asia/Dhaka" makes the day boundary midnight BD time (UTC+6)
          // Without this, MongoDB uses UTC midnight = 6:00 AM BD — wrong day grouping!
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: "Asia/Dhaka" } },
          views: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Map to simple array format matching Recharts 'name' datakey
    const viewsPerDay = viewsByDayRaw.map(v => ({ name: v._id, views: v.views }));

    // Top Channels
    const topChannelsRaw = await Audit.aggregate([
      { $match: { type: 'PLAY_START' } },
      { $group: { _id: "$channel", views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: 5 }
    ]);
    
    const topChannels = topChannelsRaw.map(t => ({ name: t._id, views: t.views }));

    res.json({
      kpis: {
        totalChannels,
        totalViews,
        errorCount: totalErrors,
        deadLinksEstimate,
        totalReactions
      },
      viewsPerDay,
      topChannels
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get recent audit logs (paginated)
router.get('/admin/audits', authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000); // Increased cap to 1000
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;
    
    // Server-side filtering
    const query = {};
    if (req.query.type && req.query.type !== 'ALL') {
      query.type = req.query.type;
    }

    const logs = await Audit.find(query).sort({ timestamp: -1 }).skip(skip).limit(limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get full details for a specific IP address
router.get('/admin/ip-details/:ip', authenticate, async (req, res) => {
  try {
    const ip = req.params.ip;
    // LOGICAL FIX: Without a limit, a single IP with millions of events would load ALL of them into RAM,
    // crashing the server. Cap at 500 for the detail view — admin sees recentLogs.slice(0,30) anyway.
    const logs = await Audit.find({ 'metadata.ip': ip }).sort({ timestamp: -1 }).limit(500);

    const channels = [...new Set(logs.map(l => l.channel).filter(Boolean))];
    const firstSeen = logs.length > 0 ? logs[logs.length - 1].timestamp : null;
    const lastSeen  = logs.length > 0 ? logs[0].timestamp : null;
    const location  = logs.find(l => l.metadata?.location)?.metadata?.location || 'Unknown';

    const eventBreakdown = logs.reduce((acc, l) => {
      acc[l.type] = (acc[l.type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      ip,
      location,
      totalVisits: logs.length,
      channels,
      firstSeen,
      lastSeen,
      eventBreakdown,
      recentLogs: logs.slice(0, 30)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get all unique visitors aggregated from audit logs
router.get('/admin/visitors', authenticate, async (req, res) => {
  try {
    const visitors = await Audit.aggregate([
      // Only include logs that have an IP address
      { $match: { 'metadata.ip': { $exists: true, $ne: null } } },
      
      // Group by IP address
      {
        $group: {
          _id: '$metadata.ip',
          totalVisits: { $sum: 1 },
          firstSeen: { $min: '$timestamp' },
          lastSeen: { $max: '$timestamp' },
          // Collect all channels watched
          channels: { $addToSet: '$channel' },
          // Keep the last known location (using $last since we sort later, but in group we just grab first available)
          locations: { $addToSet: '$metadata.location' }
        }
      },
      
      // Project the final structure
      {
        $project: {
          ip: '$_id',
          totalVisits: 1,
          firstSeen: 1,
          lastSeen: 1,
          channels: {
            // Filter out null/empty channels and count unique
            $size: {
              $filter: {
                input: '$channels',
                as: 'ch',
                cond: { $and: [{ $ne: ['$$ch', null] }, { $ne: ['$$ch', 'SYSTEM_BOT'] }] }
              }
            }
          },
          location: { 
            $arrayElemAt: [{ 
              $filter: { 
                input: '$locations', 
                as: 'loc', 
                cond: { $ne: ['$$loc', null] } 
              } 
            }, 0] 
          },
          _id: 0
        }
      },
      
      // Sort by most recently seen
      { $sort: { lastSeen: -1 } },
      // LOGICAL FIX: Cap at 2000 unique IPs
      // Without this, with millions of audit logs, the aggregation loads ALL unique IPs into memory,
      // potentially causing an OOM crash on the server. 2000 is more than enough for the admin dashboard.
      { $limit: 2000 }
    ]);

    res.json(visitors);
  } catch (err) {
    console.error("Visitor Aggregation Error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete all logs
router.delete('/admin/logs', authenticate, async (req, res) => {
  try {
    await Audit.deleteMany({});
    res.json({ message: 'All logs deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// CONTACT FORM
// ========================

// Public: Submit contact message
router.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    // SECURITY: Sanitize field lengths to prevent DB document bloat attacks
    if (name.length > 100 || email.length > 150 || subject.length > 200 || message.length > 2000) {
      return res.status(400).json({ error: 'Input too long.' });
    }
    // SECURITY: Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }
    const newContact = new Contact({ name, email, subject, message });
    await newContact.save();
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Admin: Get all contact messages
router.get('/admin/contacts', authenticate, async (req, res) => {
  try {
    // LOGICAL FIX: Cap at 500 to prevent OOM crash if bot spammed thousands of messages
    const contacts = await Contact.find().sort({ createdAt: -1 }).limit(500);
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete contact message
router.delete('/admin/contact/:id', authenticate, async (req, res) => {
  try {
    await Contact.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
