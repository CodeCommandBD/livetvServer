const mongoose = require('mongoose');

const SyncSourceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  url: { type: String, required: true, trim: true, unique: true },
  // 'json' for JSON arrays, 'm3u' for M3U/M3U8 playlists
  type: { type: String, enum: ['json', 'm3u'], required: true },
  enabled: { type: Boolean, default: true },
  // Track results of the last sync for this source
  lastSyncedAt: { type: Date, default: null },
  lastChannelCount: { type: Number, default: 0 },
  lastError: { type: String, default: null },
}, {
  timestamps: true // adds createdAt, updatedAt automatically
});

module.exports = mongoose.model('SyncSource', SyncSourceSchema);
