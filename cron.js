const cron = require('node-cron');
const axios = require('axios');

const Channel = require('./models/Channel');
const Audit = require('./models/Audit');
const Match = require('./models/Match');
const redis = require('./config/redis');

const SYNC_URLS = [
  'https://raw.githubusercontent.com/SHAJON-404/iptv/refs/heads/main/app/data/channels.json',
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'
];

// ==========================================
// 1. AUTO GITHUB SYNC (Runs Daily at 00:00)
// ==========================================
const syncFromGitHub = async () => {
  console.log('[Cron] Starting GitHub Sync...');
  try {
    let allNewChannels = [];

    for (const url of SYNC_URLS) {
      try {
        console.log(`[Cron] Fetching ${url}...`);
        const res = await axios.get(url, { timeout: 15000 });
        let parsedChannels = [];

        if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
          // Parse M3U
          // ✅ Bug Fix: Ensure data is a string before calling .split().
          // Axios may return a Buffer or Object if content-type is mismatched.
          const rawData = typeof res.data === 'string' ? res.data : res.data.toString();
          const lines = rawData.split('\n');
          let currentChannel = {};
          for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
              // ✅ Bug Fix 1: Use indexOf(',') not split(',').pop()
              // Handles channel names that contain commas e.g. "Sports, HD"
              const commaIdx = line.indexOf(',');
              const metaPart = commaIdx !== -1 ? line.substring(0, commaIdx) : line;
              const namePart = commaIdx !== -1 ? line.substring(commaIdx + 1).trim() : '';

              const logoMatch = metaPart.match(/tvg-logo="([^"]+)"/i);
              const groupMatch = metaPart.match(/group-title="([^"]+)"/i);

              // ✅ Bug Fix 3: Guard against empty string names (not just null/undefined)
              const name = namePart.length > 0 ? namePart : 'Unknown Channel';

              // ✅ Bug Fix 4: If a previous #EXTINF had no URL yet, silently discard it
              // (don't push orphaned channel objects with no stream link)
              currentChannel = { name, logo: logoMatch ? logoMatch[1] : '', group: groupMatch ? groupMatch[1] : 'Uncategorized' };
            } else if (line.startsWith('http')) {
              if (currentChannel.name) {
                // ✅ Bug Fix 5: line is already .trim()'d — strips trailing \r from Windows CRLF files
                currentChannel.url = line;
                parsedChannels.push(currentChannel);
                currentChannel = {}; // Reset
              }
            }
          }
        } else {
          // Parse JSON
          parsedChannels = res.data;
          if (!Array.isArray(parsedChannels)) {
            throw new Error("Invalid JSON format from GitHub. Expected an array.");
          }
        }
        allNewChannels = allNewChannels.concat(parsedChannels);
      } catch (err) {
        console.error(`[Cron] Failed to fetch or parse ${url}:`, err.message);
      }
    }

    if (allNewChannels.length === 0) {
      throw new Error("No channels found from any source.");
    }

    // ✅ Bug Fix 2: Deduplicate by channel name BEFORE hitting the database.
    // Without this, a channel present in BOTH the JSON source and M3U source
    // would be inserted TWICE. JSON source (index 0 in SYNC_URLS) takes priority.
    const dedupedMap = new Map();
    for (const ch of allNewChannels) {
      if (ch.name && ch.url && !dedupedMap.has(ch.name)) {
        dedupedMap.set(ch.name, ch); // first-seen wins (JSON has higher priority)
      }
    }
    const dedupedChannels = Array.from(dedupedMap.values());
    console.log(`[Cron] ${allNewChannels.length} total → ${dedupedChannels.length} unique channels after dedup.`);

    const existingChannels = await Channel.find({});
    const channelMap = new Map();
    for (const c of existingChannels) {
      channelMap.set(c.name, c);
    }

    let updatedCount = 0;
    let addedCount = 0;
    const bulkOps = [];

    for (const ghChannel of dedupedChannels) {
      if (!ghChannel.url) continue;

      const existingChannel = channelMap.get(ghChannel.name);
      
      if (existingChannel) {
        // Sync any changes from GitHub (URL, Logo, Group) to the database
        if (
          existingChannel.url !== ghChannel.url ||
          // ✅ Bug Fix 3: Only compare logos if the incoming logo is non-empty.
          // Without this guard, a channel from M3U (which has logo='') would
          // overwrite a valid logo already stored in the DB every single sync.
          (ghChannel.logo && existingChannel.logo !== ghChannel.logo) ||
          (ghChannel.group && existingChannel.group !== ghChannel.group)
        ) {
          bulkOps.push({
            updateOne: {
              filter: { _id: existingChannel._id },
              update: { 
                $set: { 
                  url: ghChannel.url,
                  logo: ghChannel.logo || existingChannel.logo,
                  group: ghChannel.group || existingChannel.group,
                  // If URL changed, assume it might be live again and reset dead status
                  status: existingChannel.url !== ghChannel.url && existingChannel.status === 'dead' ? 'live' : existingChannel.status
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
      try {
        // ordered: false — continue processing remaining ops even if one fails,
        // instead of aborting the entire batch on first error (default ordered:true behaviour).
        await Channel.bulkWrite(bulkOps, { ordered: false });
      } catch (bulkErr) {
        // BulkWriteError: some ops may have succeeded, some failed.
        // Log but don't throw — partial sync is better than total failure.
        console.error('[Cron] BulkWrite partial failure:', bulkErr.message);
        await new Audit({ type: 'AUTO_SYNC', channel: 'SYSTEM_BOT', metadata: { message: `Partial BulkWrite error: ${bulkErr.message}`, status: 'warning' } }).save().catch(() => {});
      }
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

    // Process all 50 channels concurrently instead of sequentially!
    // This reduces check time from 6+ minutes down to max 8 seconds.
    const checks = batch.map(async (channel) => {
      try {
        if (!channel.url || !channel.url.startsWith('http')) {
          await Channel.findByIdAndUpdate(channel._id, { status: 'dead' });
          return 'dead'; // ✅ Bug Fix 1: Return result instead of mutating shared counter
        }
        
        const startPing = Date.now();
        const response = await axios.get(channel.url, { 
          timeout: 8000,
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          }
        });
        
        if (response.data && typeof response.data.destroy === 'function') {
          // ✅ Bug Fix 2: Attach error listener BEFORE destroy() to prevent
          // unhandled 'error' event crash if the stream emits an error after destroy
          response.data.on('error', () => {}); // silently ignore post-destroy errors
          response.data.destroy();
        }
        
        const latency = Date.now() - startPing;
        await Channel.findByIdAndUpdate(channel._id, { status: 'live', ping: latency });
        return 'live';
      } catch (err) {
        if (err.response && (err.response.status === 404 || err.response.status === 403 || err.response.status === 410)) {
          await Channel.findByIdAndUpdate(channel._id, { status: 'dead' });
          return 'dead'; // ✅ Bug Fix 1: Return result instead of mutating shared counter
        }
        return 'unknown'; // Network timeout, ECONNRESET etc. — don't mark as dead
      }
    });

    const results = await Promise.all(checks);
    // ✅ Bug Fix 1: Count dead channels from returned results — safe, no race condition
    deadCount = results.filter(r => r === 'dead').length;

    // CRITICAL: Clear Redis Cache so frontend users instantly see the Dead/Live status and Ping updates!
    if (redis) {
      try {
        await redis.del('nexplaytv:channels');
      } catch (e) {
        console.error('[Cron] Failed to clear Redis cache:', e.message);
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
      // ✅ Bug Fix: Guard against null/invalid startTime.
      // If startTime is missing, durationMs = NaN, and NaN >= maxHours = false,
      // causing the match to stay LIVE forever and never auto-end.
      if (!match.startTime || isNaN(new Date(match.startTime).getTime())) {
        console.warn(`[Cron] Match ${match._id} has invalid startTime, skipping auto-end.`);
        continue;
      }

      const durationMs = now - match.startTime;
      const durationHours = durationMs / (1000 * 60 * 60);

      // Skip auto-end for CRICKET matches (handled manually by admin)
      if (match.sport === 'CRICKET') {
        continue;
      }

      // Define max safe duration based on sport
      let maxHours = 4; // Default 4 hours
      if (match.sport === 'FOOTBALL') maxHours = 3; // 3 hours max for football

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
  // Run GitHub Sync twice a day (Midnight 12:00 AM and Noon 12:00 PM BD Time)
  cron.schedule('0 0,12 * * *', syncFromGitHub, {
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
