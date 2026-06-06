const mongoose = require('mongoose');

const AuditSchema = new mongoose.Schema({
  type: { type: String, required: true }, // e.g., PLAY_START, PLAY_ERROR
  channel: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  error: { type: String },
  duration: { type: Number },
  metadata: { type: mongoose.Schema.Types.Mixed }
});

// TTL Index: Delete logs older than 30 days automatically
AuditSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Audit', AuditSchema);
