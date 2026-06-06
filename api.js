const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const Admin = require('./models/Admin');
const Channel = require('./models/Channel');
const Audit = require('./models/Audit');
const Setting = require('./models/Setting');
const Contact = require('./models/Contact');
const { syncFromGitHub, checkLinks } = require('./cron');

// We use the same JWT Secret from .env or fallback
const JWT_SECRET = process.env.JWT_SECRET || 'kriya_tv_super_secret_admin_key_2026';

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
    
    res.json(sortedChannels);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/automation/sync', authenticate, async (req, res) => {
  try {
    const result = await syncFromGitHub();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed' });
  }
});

router.post('/automation/check-links', authenticate, async (req, res) => {
  try {
    const result = await checkLinks();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Check failed' });
  }
});

// ========================
// HOME SECTIONS (Admin Layout Manager)
// ========================

router.get('/home-sections', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'homeSections' });
    res.json(setting ? setting.value : { cricket: [], football: [] });
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
    res.json(updated.value);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// CHANNELS (CRUD)
// ========================

// Public: Get all channels (for frontend useChannels)
router.get('/channels', async (req, res) => {
  try {
    const channels = await Channel.find().select('-__v');
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
      // Fallback if ID is actually a name
      channel = await Channel.findOneAndUpdate({ name: req.params.id }, req.body, { new: true });
    }
    
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
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
    res.json({ message: 'Channel deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========================
// AUDIT & LOGS
// ========================

// Public: Log an event (PLAY_START, PLAY_ERROR)
router.post('/audit/event', async (req, res) => {
  try {
    const { type, channel, error, duration, metadata } = req.body;
    const audit = new Audit({ type, channel, error, duration, metadata });
    await audit.save();
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
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
        streamErrors: totalErrors,
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
