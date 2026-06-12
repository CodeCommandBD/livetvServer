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
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::' || hostname === '::1' || hostname.startsWith('127.')) return false;
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
    // SECURITY FIX: Sanitize logo/group fields from untrusted source data
    // A malicious M3U source could inject a huge logo URL (e.g. 1MB string) to bloat the DB
    const dedupedMap = new Map();
    for (const ch of allNewChannels) {
      if (ch.name && ch.url && !dedupedMap.has(ch.name)) {
        // Sanitize: cap field lengths to prevent DB document bloat
        const safeCh = {
          ...ch,
          name: ch.name.substring(0, 200),
          url: ch.url.substring(0, 1000),
          logo: ch.logo ? ch.logo.substring(0, 500) : '',
          group: ch.group ? ch.group.substring(0, 100) : 'Uncategorized'
        };
        dedupedMap.set(safeCh.name, safeCh);
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

    // LOGICAL FIX: Active Channel Exclusion
    // Do NOT ping channels that users are currently watching! If the cron pings an actively watched channel,
    // the upstream IPTV server sees multiple concurrent connections from our IP and will often issue an IP ban
    // or rate limit, causing the stream to crash/freeze for 1-2 minutes for all users.
    const activeChannels = new Set();
    if (global.activeSessions) {
      for (const session of global.activeSessions.values()) {
        if (session.channelName) activeChannels.add(session.channelName);
      }
    }

    // Process all 50 channels concurrently instead of sequentially!
    // This reduces check time from 6+ minutes down to max 8 seconds.
    const checks = batch.map(async (channel) => {
      try {
        if (activeChannels.has(channel.name)) {
          // Channel is currently being watched, so it's obviously alive! Skip the ping.
          await Channel.findByIdAndUpdate(channel._id, { status: 'live' });
          return 'live';
        }

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
          update: { 
            $set: { 
              status: 'LIVE',
              liveStartedAt: now // FIX: Set liveStartedAt so frontend timer starts counting!
            } 
          }
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
// 5. AUTO SYNC LIVE SCORES FROM ESPN (Runs every 1 min)
// ==========================================

// ESPN API endpoints for all major sports & leagues
const ESPN_SCORE_APIS = [
  // International Football
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.friendly/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.worldq/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.euro/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.america/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/afc.cupofnations/scoreboard',
  // Club Football
  'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/ksa.1/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
  // Cricket
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8039/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8048/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8046/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8053/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8060/scoreboard',
  'https://site.api.espn.com/apis/site/v2/sports/cricket/8044/scoreboard',
];

/**
 * Fuzzy name match — handles partial names, hyphens, abbreviations.
 * e.g. "Bosnia" matches "Bosnia-Herzegovina" or "Bosnia & Herz."
 */
function fuzzyMatch(dbName, espnName) {
  if (!dbName || !espnName) return false;
  const normalize = (s) => s.toLowerCase()
    .replace(/[-_&.,]/g, ' ')   // Replace special chars with space
    .replace(/\s+/g, ' ')       // Collapse multiple spaces
    .trim();
  const a = normalize(dbName);
  const b = normalize(espnName);
  return a.includes(b) || b.includes(a);
}

const autoSyncEspnScores = async () => {
  try {
    // Only run if there are LIVE matches
    const liveMatches = await Match.find({ status: 'LIVE' });
    if (liveMatches.length === 0) return;

    // Fetch all ESPN scoreboards in parallel
    const responses = await Promise.allSettled(
      ESPN_SCORE_APIS.map(url =>
        axios.get(url, { timeout: 8000 }).then(r => r.data).catch(() => null)
      )
    );

    // Flatten all ESPN events into one array
    const espnEvents = [];
    responses.forEach(result => {
      if (result.status === 'fulfilled' && result.value?.events) {
        result.value.events.forEach(event => {
          try {
            const comp = event.competitions?.[0];
            if (!comp) return;
            const stateType = event.status?.type?.state;
            // Only pick in-progress matches from ESPN
            if (stateType !== 'in') return;

            const home = comp.competitors?.find(c => c.homeAway === 'home');
            const away = comp.competitors?.find(c => c.homeAway === 'away');
            if (!home || !away) return;

            espnEvents.push({
              homeName: home.team.shortDisplayName || home.team.displayName || home.team.name,
              awayName: away.team.shortDisplayName || away.team.displayName || away.team.name,
              homeScore: home.score ?? '0',
              awayScore: away.score ?? '0',
              detail: event.status?.type?.shortDetail || '',
            });
          } catch (e) {}
        });
      }
    });

    if (espnEvents.length === 0) return;

    const bulkOps = [];

    for (const match of liveMatches) {
      const t1 = match.team1?.name || '';
      const t2 = match.team2?.name || '';

      let found = null;
      let reversed = false;

      for (const e of espnEvents) {
        const t1Home = fuzzyMatch(t1, e.homeName) && fuzzyMatch(t2, e.awayName);
        const t1Away = fuzzyMatch(t1, e.awayName) && fuzzyMatch(t2, e.homeName);

        if (t1Home) { found = e; reversed = false; break; }
        if (t1Away) { found = e; reversed = true; break; }
      }

      if (!found) continue; // No ESPN match found, skip

      const newScore = {
        team1: reversed ? found.awayScore : found.homeScore,
        team2: reversed ? found.homeScore : found.awayScore,
      };

      // Only update if score actually changed — avoids unnecessary DB writes
      if (
        String(newScore.team1) === String(match.score?.team1) &&
        String(newScore.team2) === String(match.score?.team2)
      ) continue;

      console.log(`[ESPN Sync] ${t1} ${newScore.team1}–${newScore.team2} ${t2}`);

      bulkOps.push({
        updateOne: {
          filter: { _id: match._id },
          update: { $set: { 'score.team1': newScore.team1, 'score.team2': newScore.team2 } }
        }
      });
    }

    if (bulkOps.length > 0) {
      await Match.bulkWrite(bulkOps);
      // Notify frontend clients via SSE so scores update in real-time
      if (global.notifyMatchUpdate) global.notifyMatchUpdate();
      console.log(`[ESPN Sync] Updated scores for ${bulkOps.length} match(es).`);
    }

  } catch (err) {
    console.error('[Cron] ESPN Score Sync Failed:', err.message);
  }
};

// ==========================================
// 6. AUTO SYNC CRICAPI SCORES
// ==========================================
global.cricApiScoresCache = [];

const fetchCricApiScores = async () => {
  try {
    const API_KEY = 'ffe300c5-39f9-4ed1-a8ce-b1c47c7c5faf';
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${API_KEY}&offset=0`;
    
    const res = await axios.get(url);
    if (res.data && res.data.data) {
      const formattedMatches = res.data.data.map(match => {
        
        let state = 'pre';
        if (match.matchStarted && !match.matchEnded) state = 'in';
        else if (match.matchEnded) state = 'post';

        // Find scores for home and away
        let homeScoreStr = '0';
        let awayScoreStr = '0';

        const team1 = match.teamInfo?.[0] || { name: match.teams[0] };
        const team2 = match.teamInfo?.[1] || { name: match.teams[1] };

        // Parse innings if available
        if (match.score && Array.isArray(match.score)) {
          // Attempt to match team names in the inning string
          match.score.forEach(inningScore => {
            const str = `${inningScore.r}/${inningScore.w} (${inningScore.o}v)`;
            if (inningScore.inning.toLowerCase().includes(team1.name.toLowerCase())) {
              homeScoreStr = str;
            } else if (inningScore.inning.toLowerCase().includes(team2.name.toLowerCase())) {
              awayScoreStr = str;
            }
          });
        }

        return {
          id: match.id,
          sport: 'Cricket',
          name: match.name,
          shortName: match.name.split(',')[0], // e.g. "India vs Pakistan"
          state: state,
          detail: match.status,
          startTimeRaw: match.dateTimeGMT,
          home: {
            name: team1.shortname || team1.name,
            score: homeScoreStr,
            logo: team1.img || ''
          },
          away: {
            name: team2.shortname || team2.name,
            score: awayScoreStr,
            logo: team2.img || ''
          }
        };
      });

      // Filter out 'post' matches so we only keep live and upcoming
      global.cricApiScoresCache = formattedMatches.filter(m => m.state !== 'post');
      // console.log(`[CricAPI] Synced ${global.cricApiScoresCache.length} live/upcoming cricket matches.`);
    }
  } catch (error) {
    console.error('[CricAPI Error]', error.message);
  }
};

// ==========================================
// 7. INIT ALL CRON JOBS
// ==========================================
const initCronJobs = () => {
  // Run on startup
  fetchCricApiScores();
  // Run GitHub Sync twice a day (Midnight 12:00 AM and Noon 12:00 PM BD Time)
  cron.schedule('0 0,12 * * *', syncFromGitHub, {
    timezone: "Asia/Dhaka"
  });
  
  // Run Link Checker every 10 minutes
  cron.schedule('*/10 * * * *', checkLinks);

  // Check and auto-start upcoming matches every 1 minute
  cron.schedule('* * * * *', autoStartMatches);
  
  // Auto-sync live scores from ESPN every 1 minute
  cron.schedule('* * * * *', autoSyncEspnScores);

  // Fetch CricAPI scores every 15 minutes (to stay under 100/day limit)
  cron.schedule('*/15 * * * *', fetchCricApiScores);

  // Check and auto-end old live matches every 10 minutes
  cron.schedule('*/10 * * * *', autoEndMatches);
  
  console.log('[Cron] Background jobs initialized.');
};

module.exports = {
  initCronJobs,
  syncFromGitHub,
  checkLinks,
  autoStartMatches,
  autoEndMatches,
  autoSyncEspnScores,
  fetchCricApiScores,
  getCachedCricApiScores: () => global.cricApiScoresCache || []
};
