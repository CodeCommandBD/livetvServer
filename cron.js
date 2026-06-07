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

    const existingChannels = await Channel.find({});
    const channelMap = new Map();
    for (const c of existingChannels) {
      channelMap.set(c.name, c);
    }

    let updatedCount = 0;
    let addedCount = 0;
    const bulkOps = [];

    for (const ghChannel of newChannels) {
      if (!ghChannel.url) continue;

      const existingChannel = channelMap.get(ghChannel.name);
      
      if (existingChannel) {
        // If the GitHub URL has a token (?e=) and it's different from our current one, update it.
        if (existingChannel.url !== ghChannel.url && ghChannel.url.includes('?e=')) {
          bulkOps.push({
            updateOne: {
              filter: { _id: existingChannel._id },
              update: { 
                $set: { 
                  url: ghChannel.url,
                  status: existingChannel.status === 'dead' ? 'live' : existingChannel.status
                } 
              }
            }
          });
          updatedCount++;
        }
      } else {
        // New channel found in GitHub!
        bulkOps.push({
          insertOne: {
            document: { ...ghChannel, addedViaSync: true }
          }
        });
        addedCount++;
      }
    }

    if (bulkOps.length > 0) {
      await Channel.bulkWrite(bulkOps);
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
        
        // Use GET instead of HEAD because many IPTV servers block HEAD requests.
        // Increase timeout to 8 seconds for slow servers.
        // Add User-Agent to prevent bot-blocking.
        await axios.get(channel.url, { 
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          }
        });
      } catch (err) {
        // Only mark as dead if it explicitly returns a 404 (Not Found) or 403 (Forbidden/Expired)
        // Do NOT mark as dead for timeouts (ECONNABORTED) or generic 500s which could be temporary server lag
        if (err.response && (err.response.status === 404 || err.response.status === 403 || err.response.status === 410)) {
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
