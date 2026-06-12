const mongoose = require('mongoose');

const MatchSchema = new mongoose.Schema({
  sport: { type: String, required: true }, // e.g., 'FOOTBALL', 'CRICKET'
  status: { type: String, required: true, enum: ['UPCOMING', 'LIVE', 'ENDED'], default: 'UPCOMING' },
  startTime: { type: Date, required: true },
  team1: {
    name: { type: String, required: true },
    // LOGICAL FIX: flagUrl should NOT be required.
    // Club teams (e.g. Man City vs Arsenal) don't have country flag URLs.
    // Making it required blocks creating club football matches entirely!
    flagUrl: { type: String, default: '' }
  },
  team2: {
    name: { type: String, required: true },
    flagUrl: { type: String, default: '' }
  },
  score: {
    team1: { type: Number, default: 0 }, // Realtime goal count for team1
    team2: { type: Number, default: 0 }  // Realtime goal count for team2
  },
  liveStartedAt: { type: Date, default: null }, // When admin marked as LIVE (for timer)
  channelName: { type: String, required: true }, // The NexPlay TV channel to redirect to
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Match', MatchSchema);
