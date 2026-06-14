const mongoose = require('mongoose');

const ChannelSchema = new mongoose.Schema({
  // CRITICAL SECURITY FIX: Database Constraint Bug
  // Enforce unique: true to prevent duplicate channels. Without this, admins could create
  // two channels with the same name, resulting in un-deletable "Ghost Channels" because
  // findOneAndUpdate/Delete would only ever target the first one, breaking the Admin Panel and GitHub Sync!
  name: { type: String, required: true, unique: true },
  logo: { type: String, default: '' },
  group: { type: String, default: '' },
  url: { type: String, required: true },
  status: { type: String, default: 'live' },
  drmKeyId: { type: String, default: '' },
  drmKey: { type: String, default: '' },
  verified_at: { type: Date, default: Date.now },
  status_code: { type: Number, default: 200 },
  content_type: { type: String, default: 'application/vnd.apple.mpegurl' },
  addedViaSync: { type: Boolean, default: false },
  reactionsCount: { type: Number, default: 0 },
  ping: { type: Number, default: 0 }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

module.exports = mongoose.model('Channel', ChannelSchema);
