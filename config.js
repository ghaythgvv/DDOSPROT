require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  alertChannelId: process.env.ALERT_CHANNEL_ID || '1561488774393892956',
  prefix: process.env.PREFIX || '!',

  lagThresholdMs: 250,          // latency above this = bad check
  strikesBeforeSwitch: 1,       // bad checks in a row before reacting (2-3 = fewer false alarms)
  checkIntervalMs: 5000,        // how often to check
  switchCooldownMs: 45000,      // wait after a region change before checking again
  suspectWindowMs: 60000,       // who did something in the last N ms before the lag
  strikeMemoryMs: 7 * 24 * 60 * 60 * 1000, // how long a strike counts (7 days)
  strikesForTimeout: 2,         // 1st = alert + region change, 2nd = also timeout
  timeoutHours: 24,
  autoTimeout: process.env.AUTO_TIMEOUT !== 'false',

  // Regions to rotate through. null = automatic.
  regions: ['rotterdam', 'russia', 'southafrica', 'india', null],
};
