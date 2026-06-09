const cron = require('node-cron');
const axios = require('axios');

const Channel = require('./models/Channel');
const Audit = require('./models/Audit');
const Match = require('./models/Match');
const redis = require('./config/redis');

const GITHUB_URL = 'https://raw.githubusercontent.com/SHAJON-404/iptv/refs/heads/main/app/data/channels.json';

// ==========================================
// 1. AUTO GITHUB SYNC (Runs Daily at 00:00)
// ==========================================
const syncFromGitHub = async () => {
  console.log('[Cron] Starting GitHub Sync...');
  try {
    const res = await axios.get(GITHUB_URL);
    const newChannels = res.data;
    if (!Array.isArray(newChannels)) {
      throw new Error("Invalid JSON format from GitHub. Expected an array.");
    }

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
      if (redis) {
        try {
          await redis.del('nexplaytv:channels');
          console.log('[Cron] Cleared Redis cache after sync.');
        } catch (e) {
          console.error('[Cron] Failed to clear Redis cache:', e.message);
        }
      }
    }

    const message = `Added ${addedCount} new channels, updated ${updatedCount} expired tokens.`;
    await new Audit({ type: 'AUTO_SYNC', channel: 'SYSTEM_BOT', metadata: { message, status: 'success' } }).save();
    console.log(`[Cron] Sync Complete: ${addedCount} added, ${updatedCount} updated.`);
    return { addedCount, updatedCount };
  } catch (err) {
    await new Audit({ type: 'AUTO_SYNC', channel: 'SYSTEM_BOT', metadata: { message: err.message, status: 'error' } }).save().catch(()=>{});
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

    const message = `Checked ${batch.length} random channels, found ${deadCount} dead links.`;
    await new Audit({ type: 'AUTO_CHECK', channel: 'SYSTEM_BOT', metadata: { message, status: 'success' } }).save();
    console.log(`[Cron] Link Checker Batch Complete. Found ${deadCount} dead links in this batch.`);
    return { checked: batch.length, deadCount };
  } catch (err) {
    await new Audit({ type: 'AUTO_CHECK', channel: 'SYSTEM_BOT', metadata: { message: err.message, status: 'error' } }).save().catch(()=>{});
    console.error('[Cron] Link checker failed:', err.message);
  }
};

// ==========================================
// 3. AUTO START MATCHES (Runs every 1 min)
// ==========================================
const autoStartMatches = async () => {
  try {
    const now = new Date();
    // Find all upcoming matches whose start time has passed
    const matchesToStart = await Match.find({
      status: 'UPCOMING',
      startTime: { $lte: now }
    });

    if (matchesToStart.length > 0) {
      console.log(`[Cron] Auto-starting ${matchesToStart.length} matches...`);
      
      const bulkOps = matchesToStart.map(match => ({
        updateOne: {
          filter: { _id: match._id },
          update: { $set: { status: 'LIVE' } }
        }
      }));

      await Match.bulkWrite(bulkOps);
      
      // Notify clients to refresh matches list instantly via SSE
      if (global.notifyMatchUpdate) {
        global.notifyMatchUpdate();
      }
      
      console.log(`[Cron] Successfully updated ${matchesToStart.length} matches to LIVE.`);
    }
  } catch (err) {
    console.error('[Cron] Auto Start Matches Failed:', err.message);
  }
};

// ==========================================
// 4. AUTO END MATCHES (Runs every 10 mins)
// ==========================================
const autoEndMatches = async () => {
  try {
    const now = new Date();
    
    // Find all LIVE matches
    const liveMatches = await Match.find({ status: 'LIVE' });
    if (liveMatches.length === 0) return;

    const bulkOps = [];
    let endedCount = 0;

    for (const match of liveMatches) {
      const durationMs = now - match.startTime;
      const durationHours = durationMs / (1000 * 60 * 60);

      // Define max safe duration based on sport
      let maxHours = 4; // Default 4 hours
      if (match.sport === 'FOOTBALL') maxHours = 3; // 3 hours max for football
      if (match.sport === 'CRICKET') maxHours = 8; // 8 hours max to cover ODIs

      if (durationHours >= maxHours) {
        bulkOps.push({
          updateOne: {
            filter: { _id: match._id },
            update: { $set: { status: 'ENDED' } }
          }
        });
        endedCount++;
      }
    }

    if (bulkOps.length > 0) {
      await Match.bulkWrite(bulkOps);
      if (global.notifyMatchUpdate) {
        global.notifyMatchUpdate();
      }
      console.log(`[Cron] Successfully auto-ended ${endedCount} matches.`);
    }
  } catch (err) {
    console.error('[Cron] Auto End Matches Failed:', err.message);
  }
};

// ==========================================
// INITIALIZE CRON JOBS
// ==========================================
const initCronJobs = () => {
  // Run GitHub Sync every midnight Bangladesh Time (00:00 BD / 18:00 UTC)
  cron.schedule('0 0 * * *', syncFromGitHub, {
    timezone: "Asia/Dhaka"
  });
  
  // Run Link Checker every 10 minutes
  cron.schedule('*/10 * * * *', checkLinks);

  // Check and auto-start upcoming matches every 1 minute
  cron.schedule('* * * * *', autoStartMatches);
  
  // Check and auto-end old live matches every 10 minutes
  cron.schedule('*/10 * * * *', autoEndMatches);
  
  console.log('[Cron] Background jobs initialized.');
};

module.exports = {
  initCronJobs,
  syncFromGitHub,
  checkLinks,
  autoStartMatches,
  autoEndMatches
};
