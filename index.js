const { Client, GatewayIntentBits, PermissionFlagsBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const config = require('./config');

if (!config.token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,     // enable "Server Members Intent" in the dev portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // enable "Message Content Intent" in the dev portal
  ],
});

// ---------------- state ----------------
const badChecks = new Map();   // channelId -> consecutive bad checks
const lastSwitch = new Map();  // channelId -> timestamp of last region change
const events = new Map();      // channelId -> [{ t, userId, what }]
const strikes = new Map();     // "guildId:userId" -> [timestamps]

const resetState = (cid) => badChecks.delete(cid);

function record(channelId, userId, what) {
  const list = events.get(channelId) ?? [];
  list.push({ t: Date.now(), userId, what });
  if (list.length > 100) list.shift();
  events.set(channelId, list);
}

const isExempt = (member) =>
  member.user.bot || member.permissions.has(PermissionFlagsBits.Administrator);

async function alert(guild, text) {
  console.log(`[${guild.name}] ${text}`);
  try {
    const ch = await client.channels.fetch(config.alertChannelId);
    await ch.send({ content: text, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error("Couldn't send alert:", e.message);
  }
}

function getLatency(connection) {
  const { udp, ws } = connection.ping;
  const v = Number.isFinite(udp) ? udp : ws;
  return Number.isFinite(v) ? v : null;
}

// ---------------- record what people do in voice ----------------
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const member = newState.member;
  if (!member || member.user.bot || !newState.channelId) return;
  const cid = newState.channelId;
  if (oldState.channelId !== newState.channelId) record(cid, member.id, 'joined the call');
  if (newState.streaming && !oldState.streaming) record(cid, member.id, 'started streaming');
  if (newState.selfVideo && !oldState.selfVideo) record(cid, member.id, 'turned on their camera');
});

// Soundboard (only fires on discord.js versions that support it)
client.on('voiceChannelEffectSend', (effect) => {
  if (effect.soundId && effect.userId && effect.channelId) {
    record(effect.channelId, effect.userId, 'played a soundboard sound');
  }
});

// ---------------- lag handling ----------------
function findSuspect(channel, now) {
  const list = events.get(channel.id) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i];
    if (now - ev.t > config.suspectWindowMs) break;
    const member = channel.members.get(ev.userId);
    if (member && !isExempt(member)) return { suspect: member, what: ev.what };
  }
  return { suspect: null, what: null };
}

async function handleLag(guild, channel, latency) {
  const now = Date.now();
  const { suspect, what } = findSuspect(channel, now);

  const current = channel.rtcRegion ?? null;
  const idx = config.regions.indexOf(current);
  const next = config.regions[(idx + 1) % config.regions.length];

  try {
    await channel.setRTCRegion(next, `Lag detected: ${Math.round(latency)} ms`);
  } catch (e) {
    return alert(
      guild,
      `⚠️ Lag in **${channel.name}** (${Math.round(latency)} ms) but I couldn't change the region: ${e.message}. I need **Manage Channels**.`,
    );
  }
  resetState(channel.id);
  const regionTxt = `Region: **${current ?? 'automatic'}** → **${next ?? 'automatic'}**.`;

  if (!suspect) {
    return alert(guild, `🚨 Lag in **${channel.name}** (${Math.round(latency)} ms). No suspect found. ${regionTxt}`);
  }

  const key = `${guild.id}:${suspect.id}`;
  const list = (strikes.get(key) ?? []).filter((t) => now - t < config.strikeMemoryMs);
  list.push(now);
  strikes.set(key, list);
  const n = list.length;

  let msg =
    `🚨 Lag in **${channel.name}** (${Math.round(latency)} ms). ` +
    `Most likely cause: **${suspect.user.tag}** (\`${suspect.id}\`), who ${what}. ` +
    `Strike **${n}**. ${regionTxt}`;

  if (config.autoTimeout && n >= config.strikesForTimeout) {
    try { await suspect.voice.disconnect('Repeated voice lag'); } catch {}
    try {
      await suspect.timeout(config.timeoutHours * 3600 * 1000, 'Repeated voice lag incidents');
      msg += ` 🔇 Timed out for ${config.timeoutHours}h and removed from the call.`;
    } catch {
      msg += " ⚠️ Couldn't time them out (move my role above theirs / give me Moderate Members).";
    }
  }
  await alert(guild, msg);
}

let checking = false;
async function monitor() {
  if (checking) return;
  checking = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      const connection = getVoiceConnection(guild.id);
      if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) continue;

      const channel = guild.channels.cache.get(connection.joinConfig.channelId);
      if (!channel) continue;
      const cid = channel.id;

      // everyone left -> leave too
      if (!channel.members.some((m) => !m.user.bot)) {
        resetState(cid);
        connection.destroy();
        continue;
      }

      // just switched region -> give it time to reconnect
      if (Date.now() - (lastSwitch.get(cid) ?? 0) < config.switchCooldownMs) continue;

      const latency = getLatency(connection);
      if (latency === null) continue;

      if (latency <= config.lagThresholdMs) {
        badChecks.set(cid, 0);
        continue;
      }

      const bad = (badChecks.get(cid) ?? 0) + 1;
      badChecks.set(cid, bad);
      if (bad < config.strikesBeforeSwitch) continue;

      lastSwitch.set(cid, Date.now());
      await handleLag(guild, channel, latency);
    }
  } catch (e) {
    console.error('Monitor error:', e);
  } finally {
    checking = false;
  }
}

// ---------------- commands ----------------
const hasManageGuild = (member) => member.permissions.has(PermissionFlagsBits.ManageGuild);

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(config.prefix)) return;
  const [cmd, ...args] = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const p = config.prefix;

  switch (cmd.toLowerCase()) {
    case 'aurafarm': {
      const channel = message.member.voice.channel;
      if (!channel) return message.reply('Join a voice channel first.');
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        }
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      } catch {
        connection.destroy();
        return message.reply("Couldn't connect to the voice channel (check my Connect permission).");
      }
      resetState(channel.id);
      return message.reply(`Joined **${channel.name}**. Watching for lag until everyone leaves.`);
    }

    case 'leave': {
      const connection = getVoiceConnection(message.guild.id);
      if (!connection) return message.reply("I'm not in a voice channel.");
      connection.destroy();
      return message.reply('Left the voice channel.');
    }

    case 'ping': {
      const connection = getVoiceConnection(message.guild.id);
      if (!connection) return message.reply("I'm not in a voice channel.");
      const latency = getLatency(connection);
      const channel = message.guild.channels.cache.get(connection.joinConfig.channelId);
      const region = channel?.rtcRegion ?? 'automatic';
      const ms = latency === null ? 'measuring...' : `${Math.round(latency)} ms`;
      return message.reply(`Voice latency: **${ms}** | Region: **${region}**`);
    }

    case 'pardon': {
      if (!hasManageGuild(message.member)) return message.reply('You need **Manage Server** for that.');
      const target =
        message.mentions.members.first() ??
        (args[0] ? await message.guild.members.fetch(args[0]).catch(() => null) : null);
      if (!target) return message.reply(`Usage: \`${p}pardon @user\``);
      strikes.delete(`${message.guild.id}:${target.id}`);
      return message.reply(`Cleared strikes for ${target.user.tag}.`);
    }

    case 'help':
      return message.reply(
        [
          `**${p}aurafarm** - join your voice channel and watch for lag until everyone leaves`,
          `**${p}leave** - leave the voice channel`,
          `**${p}ping** - show current voice latency and region`,
          `**${p}pardon @user** - clear someone's strikes (Manage Server)`,
        ].join('\n'),
      );
  }
});

// ---------------- start ----------------
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(monitor, config.checkIntervalMs);
});

client.on('error', (e) => console.error('Client error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

client.login(config.token);
