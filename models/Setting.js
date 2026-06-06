const mongoose = require('mongoose');

const SettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g., 'homeSections'
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});

module.exports = mongoose.model('Setting', SettingSchema);
