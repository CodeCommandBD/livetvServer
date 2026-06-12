const cron = require('node-cron');
const axios = require('axios');

const Channel = require('./models/Channel');
const Audit = require('./models/Audit');
const Match = require('./models/Match');
const SyncSource = require('./models/SyncSource');
const redis = require('./config/redis');

const { URL } = require('url');

// Regex to detect any valid streaming URL protocol
// Fixes RTMP/RTSP skip bug where only 'http' was checked before
const STREAM_URL_REGEX = /^(https?|rtmp|rtmps|rtsp|udp):///i;

// Function to prevent Server-Side Request Forgery (SSRF)
function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();
    
    // Block localhost, internal subnets, and AWS/Cloud metadata IPs
    if (hostname === 'localhost' || hostname.startsWith('127.')) return false;
    if (hostname === '169.254.169.254' || hostname === '[fd00:ec2::254]') return false;
    if (hostname.startsWith('10.')) return false;
    if (hostname.startsWith('192.168.')) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return false;
    
    return true;
  } catch (e) {
    return false;
  }
}

// ==========================================
// 1. AUTO SYNC (reads sources from DB)
// ==========================================
const syncFromGitHub = async () => {
  console.log('[Cron] Starting Dynamic Sync...');
  try {
    // Load only enabled sources from the database (Dynamic!)
    const sources = await SyncSource.find({ enabled: true });

    if (sources.length === 0) {
      console.log('[Cron] No enabled sync sources found. Skipping.');
      return { addedCount: 0, updatedCount: 0 };
    }

    let allNewChannels = [];

    for (const source of sources) {
      try {
        console.log(`[Cron] Fetching "${source.name}" → ${source.url}`);
        
        // Security: Block SSRF attacks
        if (!isSafeUrl(source.url)) {
          throw new Error('Unsafe URL detected. Connection blocked.');
        }

        const res = await axios.get(source.url, { 
          timeout: 20000,
          maxContentLength: 10 * 1024 * 1024, // 10MB limit (DoS Protection)
          maxBodyLength: 10 * 1024 * 1024
        });
        let parsedChannels = [];

        if (source.type === 'm3u') {
          // ✅ Ensure data is always a string — Axios may return Buffer/Object on content-type mismatch
          const rawData = typeof res.data === 'string' ? res.data : res.data.toString();
          const lines = rawData.split('\n');
          let currentChannel = {};

          for (let line of lines) {
            line = line.trim();

            if (line.startsWith('#EXTINF:')) {
              // ✅ Use indexOf(',') not split — channel names can contain commas e.g. "Sports, HD"
              const commaIdx = line.indexOf(',');
              const metaPart = commaIdx !== -1 ? line.substring(0, commaIdx) : line;
              const namePart = commaIdx !== -1 ? line.substring(commaIdx + 1).trim() : '';

              const logoMatch = metaPart.match(/tvg-logo="([^"]+)"/i);
              const groupMatch = metaPart.match(/group-title="([^"]+)"/i);

              // ✅ Guard against empty string names
              const name = namePart.length > 0 ? namePart : 'Unknown Channel';
              currentChannel = {
                name,
                logo: logoMatch ? logoMatch[1] : '',
                group: groupMatch ? groupMatch[1] : 'Uncategorized'
              };

            } else if (STREAM_URL_REGEX.test(line)) {
              // ✅ RTMP BUG FIX: Accept rtmp://, rtsp://, http://, https://, udp:// — not just http
              if (currentChannel.name) {
                currentChannel.url = line; // line is already trimmed, strips \r
                parsedChannels.push({ ...currentChannel });
                currentChannel = {}; // Reset for next channel
              }
            }
          }
        } else {
          // JSON source
          parsedChannels = Array.isArray(res.data) ? res.data : [];
          if (parsedChannels.length === 0) {
            throw new Error('Invalid JSON: expected a non-empty array.');
          }
        }

        console.log(`[Cron] Parsed ${parsedChannels.length} channels from "${source.name}"`);
        allNewChannels = allNewChannels.concat(parsedChannels);

        // Update per-source metadata so admin can see last sync time & count
        await SyncSource.findByIdAndUpdate(source._id, {
          lastSyncedAt: new Date(),
          lastChannelCount: parsedChannels.length,
          lastError: null
        });

      } catch (err) {
        console.error(`[Cron] Failed to fetch/parse "${source.name}": ${err.message}`);
        // Record error on the source so admin can see it in the UI
        await SyncSource.findByIdAndUpdate(source._id, {
          lastSyncedAt: new Date(),
          lastError: err.message
        });
      }
    }

    if (allNewChannels.length === 0) {
      throw new Error('No channels parsed from any enabled source.');
    }

    // ✅ Deduplicate by name BEFORE hitting DB — first-seen (higher priority source) wins
    const dedupedMap = new Map();
    for (const ch of allNewChannels) {
      if (ch.name && ch.url && !dedupedMap.has(ch.name)) {
        dedupedMap.set(ch.name, ch);
      }
    }
    const dedupedChannels = Array.from(dedupedMap.values());
    console.log(`[Cron] ${allNewChannels.length} total → ${dedupedChannels.length} unique after dedup.`);

    // Load all existing DB channels into a Map for O(1) lookup
    const existingChannels = await Channel.find({});
    const channelMap = new Map();
    for (const c of existingChannels) channelMap.set(c.name, c);

    let updatedCount = 0;
    let addedCount = 0;
    const bulkOps = [];

    for (const incoming of dedupedChannels) {
      if (!incoming.url) continue;

      const existing = channelMap.get(incoming.name);

      if (existing) {
        // Only update if something actually changed (avoid unnecessary DB writes)
        const urlChanged = existing.url !== incoming.url;
        const logoChanged = incoming.logo && existing.logo !== incoming.logo;
        const groupChanged = incoming.group && existing.group !== incoming.group;

        if (urlChanged || logoChanged || groupChanged) {
          bulkOps.push({
            updateOne: {
              filter: { _id: existing._id },
              update: {
                $set: {
                  url: incoming.url,
                  // ✅ Never overwrite a valid logo with an empty string
                  logo: incoming.logo || existing.logo,
                  group: incoming.group || existing.group,
                  // If URL changed and was dead, give it a second chance
                  status: urlChanged && existing.status === 'dead' ? 'live' : existing.status
                }
              }
            }
          });
          updatedCount++;
        }
      } else {
        // Brand new channel — insert it
        bulkOps.push({
          insertOne: {
            document: { ...incoming, addedViaSync: true }
          }
        });
        addedCount++;
      }
    }

    if (bulkOps.length > 0) {
      try {
        // ordered: false — don't abort on first error, process all ops
        await Channel.bulkWrite(bulkOps, { ordered: false });
      } catch (bulkErr) {
        console.error('[Cron] BulkWrite partial failure:', bulkErr.message);
      }

      // Clear Redis channel cache so users get fresh data immediately
      if (redis) {
        try {
          await redis.del('nexplaytv:channels');
          console.log('[Cron] Cleared Redis cache after sync.');
        } catch (e) {
          console.error('[Cron] Redis clear failed:', e.message);
        }
      }
    }

    const message = `Added ${addedCount} new, updated ${updatedCount} channels from ${sources.length} source(s).`;
    await new Audit({ type: 'AUTO_SYNC', channel: 'SYSTEM_BOT', metadata: { message, status: 'success' } }).save();
    console.log(`[Cron] Sync Complete: ${message}`);
    return { addedCount, updatedCount };

  } catch (err) {
    await new Audit({ type: 'AUTO_SYNC', channel: 'SYSTEM_BOT', metadata: { message: err.message, status: 'error' } }).save().catch(() => {});
    console.error('[Cron] Sync Failed:', err.message);
  }
};

// ==========================================
// 2. AUTO LINK CHECKER (Runs every 10 mins)
// ==========================================
// Checks 50 random channels every 10 minutes to avoid IP bans
const checkLinks = async () => {
  console.log('[Cron] Starting Link Checker Batch...');
  
  try {
    // Pick 50 random channels (both live and dead)
    // ✅ Bug Fix 3: Removed { status: { $ne: 'dead' } }
    // Dead channels must be checked periodically to see if the server came back online!
    const batch = await Channel.aggregate([
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
        
        // Security: Block SSRF in link checker
        if (!isSafeUrl(channel.url)) {
          await Channel.findByIdAndUpdate(channel._id, { status: 'dead' });
          return 'dead';
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
