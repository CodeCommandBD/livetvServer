const mongoose = require('mongoose');

const AuditSchema = new mongoose.Schema({
  type: { type: String, required: true }, // e.g., PLAY_START, PLAY_ERROR, AUTO_SYNC
  // ✅ Fix Bug: channel is NOT required — system logs (AUTO_SYNC, AUTO_CHECK) have no channel
  channel: { type: String, required: false, default: null },
  timestamp: { type: Date, default: Date.now },
  error: { type: String },
  duration: { type: Number },
  metadata: { type: mongoose.Schema.Types.Mixed }
});

// TTL Index: Auto-delete logs older than 5 days to prevent DB storage exhaustion
AuditSchema.index({ timestamp: 1 }, { expireAfterSeconds: 5 * 24 * 60 * 60 });

// ✅ Fix Bug: Sparse index on metadata.ip for fast IP-detail queries
// 'sparse: true' means documents without metadata.ip are excluded from the index
AuditSchema.index({ 'metadata.ip': 1 }, { sparse: true });

module.exports = mongoose.model('Audit', AuditSchema);
