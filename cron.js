const cron = require('node-cron');
const axios = require('axios');

const Channel = require('./models/Channel');

const GITHUB_URL = 'https://raw.githubusercontent.com/SHAJON-404/iptv/refs/heads/main/app/data/channels.json';

// ==========================================
// 1. AUTO GITHUB SYNC (Runs Daily at 00:00)
// ==========================================
const syncFromGitHub = async () => {
  console.log('[Cron] Starting GitHub Sync...');
  try {
    const res = await axios.get(GITHUB_URL);
    const newChannels = res.data;
    if (!Array.isArray(newChannels)) return;

    let updatedCount = 0;
    let addedCount = 0;

    for (const ghChannel of newChannels) {
      if (!ghChannel.url) continue;

      const existingChannel = await Channel.findOne({ name: ghChannel.name });
      
      if (existingChannel) {
        // If the GitHub URL has a token (?e=) and it's different from our current one, update it.
        if (existingChannel.url !== ghChannel.url && ghChannel.url.includes('?e=')) {
          existingChannel.url = ghChannel.url;
          // Optionally reset status to live if it was dead and we got a new link
          if (existingChannel.status === 'dead') {
            existingChannel.status = 'live';
          }
          await existingChannel.save();
          updatedCount++;
        }
      } else {
        // New channel found in GitHub!
        const newCh = new Channel({
          ...ghChannel,
          addedViaSync: true
        });
        await newCh.save();
        addedCount++;
      }
    }

    console.log(`[Cron] Sync Complete: ${addedCount} added, ${updatedCount} updated.`);
    return { addedCount, updatedCount };
  } catch (err) {
    console.error('[Cron] GitHub Sync Failed:', err.message);
  }
};

// ==========================================
// 2. AUTO LINK CHECKER (Runs every 10 mins)
// ==========================================
// Checks 50 random channels every 10 minutes to avoid IP bans
const checkLinks = async () => {
  console.log('[Cron] Starting Link Checker Batch...');
  
  try {
    // Pick 50 random channels that are not already marked as dead
    const batch = await Channel.aggregate([
      { $match: { status: { $ne: 'dead' } } },
      { $sample: { size: 50 } }
    ]);

    let deadCount = 0;

    for (const channel of batch) {
      try {
        if (!channel.url || !channel.url.startsWith('http')) {
          await Channel.findByIdAndUpdate(channel._id, { status: 'dead' });
          deadCount++;
          continue;
        }
        
        // Small timeout, HEAD request
        await axios.head(channel.url, { timeout: 3000 });
      } catch (err) {
        // If it's a 404 or 502, mark it as dead
        // Also handle network errors (e.g. ENOTFOUND) as dead
        if (!err.response || err.response.status === 404 || err.response.status >= 500) {
          await Channel.findByIdAndUpdate(channel._id, { status: 'dead' });
          deadCount++;
        }
      }
    }

    console.log(`[Cron] Link Checker Batch Complete. Found ${deadCount} dead links in this batch.`);
    return { checked: batch.length, deadCount };
  } catch (err) {
    console.error('[Cron] Link checker failed:', err.message);
    return { checked: 0, deadCount: 0 };
  }
};

// ==========================================
// INITIALIZE CRON JOBS
// ==========================================
const initCronJobs = () => {
  // Run GitHub Sync every midnight
  cron.schedule('0 0 * * *', syncFromGitHub);
  
  // Run Link Checker every 10 minutes
  cron.schedule('*/10 * * * *', checkLinks);
  
  console.log('[Cron] Background jobs initialized.');
};

module.exports = {
  initCronJobs,
  syncFromGitHub,
  checkLinks
};
