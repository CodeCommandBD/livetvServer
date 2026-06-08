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
const { syncFromGitHub, checkLinks } = require('./cron');
const redis = require('./config/redis');

// We use the same JWT Secret from .env or fallback
const JWT_SECRET = process.env.JWT_SECRET || 'nexplay_tv_super_secret_admin_key_2026';

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

router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });

    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

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
      const cachedTrending = await redis.get('nexplaytv:trending');
      if (cachedTrending) return res.json(cachedTrending);
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
      await redis.set('nexplaytv:trending', sortedChannels, { ex: 300 }); // Cache for 5 mins
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
// MATCHES (Live & Upcoming)
// ========================

let matchClients = [];

const notifyMatchUpdate = () => {
  matchClients.forEach(client => client.write(`data: update\n\n`));
};

router.get('/matches/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial heartbeat
  res.write(`data: connected\n\n`);

  matchClients.push(res);

  req.on('close', () => {
    matchClients = matchClients.filter(c => c !== res);
  });
});

router.get('/matches', async (req, res) => {
  try {
    const query = req.query.all === 'true' ? {} : { status: { $ne: 'ENDED' } };
    const matches = await Match.find(query).sort({ startTime: 1 });
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/admin/matches', authenticate, async (req, res) => {
  try {
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
    const match = await Match.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!match) return res.status(404).json({ error: 'Match not found' });
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
      const cachedSections = await redis.get('nexplaytv:homeSections');
      if (cachedSections) return res.json(cachedSections);
    }
    const setting = await Setting.findOne({ key: 'homeSections' });
    const sections = setting ? setting.value : { cricket: [], football: [] };
    if (redis) {
      await redis.set('nexplaytv:homeSections', sections, { ex: 3600 }); // Cache for 1 hour
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
    if (redis) await redis.del('nexplaytv:homeSections');
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
      const cachedChannels = await redis.get('nexplaytv:channels');
      if (cachedChannels) return res.json(cachedChannels);
    }
    
    const channels = await Channel.find().select('-__v');
    
    if (redis) {
      await redis.set('nexplaytv:channels', channels, { ex: 3600 }); // Cache for 1 hour
    }
    
    res.json(channels);
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
    let channel;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      channel = await Channel.findByIdAndUpdate(req.params.id, req.body, { new: true });
    } else {
      channel = await Channel.findOneAndUpdate({ name: req.params.id }, req.body, { new: true });
    }
    
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    invalidateCache();
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Delete a channel
router.delete('/channels/:id', authenticate, async (req, res) => {
  try {
    let result;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      result = await Channel.findByIdAndDelete(req.params.id);
    } else {
      result = await Channel.findOneAndDelete({ name: req.params.id });
    }
    
    if (!result) return res.status(404).json({ error: 'Channel not found' });
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

// Audit Event Logging
router.post('/audit/event', async (req, res) => {
  try {
    const { type, channel, error } = req.body;
    if (!type || !channel) return res.status(400).json({ error: 'Missing data' });
    
    // Extract IP BEFORE responding (to ensure req.socket/headers are still available)
    const forwardedFor = req.headers['x-forwarded-for'];
    const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;

    // Respond immediately so the client isn't blocked
    res.json({ success: true });

    // Process asynchronously
    
    let location = 'Unknown Location';
    
    if (userIP) {
      if (userIP === '127.0.0.1' || userIP === '::1' || userIP.startsWith('192.168.')) {
        location = 'Localhost';
      } else if (global.ipLocationCache && global.ipLocationCache.has(userIP)) {
        location = global.ipLocationCache.get(userIP);
      } else {
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

// Real-time Channel Tracking Ping
router.post('/analytics/ping', (req, res) => {
  const { channelName } = req.body;
  const forwardedFor = req.headers['x-forwarded-for'];
  const userIP = forwardedFor ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress;
  
  if (userIP && channelName && global.activeSessions) {
    global.activeSessions.set(userIP, { channelName, lastSeen: Date.now() });

    // Background fetch for IP location if not cached
    if (global.ipLocationCache && !global.ipLocationCache.has(userIP)) {
      if (userIP === '127.0.0.1' || userIP === '::1' || userIP.startsWith('192.168.')) {
        global.ipLocationCache.set(userIP, 'Localhost');
      } else {
        global.ipLocationCache.set(userIP, 'Fetching...');
        axios.get(`http://ip-api.com/json/${userIP}`).then(resp => {
          if (resp.data && resp.data.status === 'success') {
            global.ipLocationCache.set(userIP, resp.data.city || resp.data.country);
          } else {
            global.ipLocationCache.set(userIP, 'Unknown');
          }
        }).catch(() => {
          global.ipLocationCache.set(userIP, 'Unknown');
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

    // Views by day for last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const viewsByDayRaw = await Audit.aggregate([
      { $match: { type: 'PLAY_START', timestamp: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
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
        deadLinksEstimate
      },
      viewsPerDay,
      topChannels
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Get recent audit logs
router.get('/admin/audits', authenticate, async (req, res) => {
  try {
    const logs = await Audit.find().sort({ timestamp: -1 }).limit(100);
    res.json(logs);
  } catch (err) {
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
    const contacts = await Contact.find().sort({ createdAt: -1 });
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
