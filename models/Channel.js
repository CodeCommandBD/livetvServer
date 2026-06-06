const mongoose = require('mongoose');

const ChannelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  logo: { type: String, default: '' },
  group: { type: String, default: '' },
  url: { type: String, required: true },
  status: { type: String, default: 'live' },
  verified_at: { type: Date, default: Date.now },
  status_code: { type: Number, default: 200 },
  content_type: { type: String, default: 'application/vnd.apple.mpegurl' },
  addedViaSync: { type: Boolean, default: false }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

module.exports = mongoose.model('Channel', ChannelSchema);
