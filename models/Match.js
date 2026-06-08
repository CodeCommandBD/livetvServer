const mongoose = require('mongoose');

const MatchSchema = new mongoose.Schema({
  sport: { type: String, required: true }, // e.g., 'FOOTBALL', 'CRICKET'
  status: { type: String, required: true, enum: ['UPCOMING', 'LIVE', 'ENDED'], default: 'UPCOMING' },
  startTime: { type: Date, required: true },
  team1: {
    name: { type: String, required: true },
    flagUrl: { type: String, required: true }
  },
  team2: {
    name: { type: String, required: true },
    flagUrl: { type: String, required: true }
  },
  channelName: { type: String, required: true }, // The NexPlay TV channel to redirect to
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Match', MatchSchema);
