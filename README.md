# VCGuard

A Discord bot that watches voice-channel lag. When lag spikes it switches the channel's voice region, posts an alert naming the most likely cause, and times out repeat offenders.

## How it works

1. Someone in a voice channel types `!join`. The bot joins and starts measuring voice latency every 5 seconds.
2. It records what people do in the call: joining, streaming, turning on a camera, playing a soundboard sound.
3. If latency goes above 250 ms, it changes the region right away and sends an alert (with the suspect's name and ID) to the alert channel.
4. If the same person is the suspect again (strike 2), it changes the region, removes them from the call and times them out for 24 hours.
5. The bot leaves on its own when everyone has left the channel.

> The bot **guesses** the cause from timing. It can blame the wrong person. Start with `AUTO_TIMEOUT=false` and check the alerts before enabling timeouts.

## Commands

| Command | What it does |
|---|---|
| `!join` | Join your voice channel and watch for lag |
| `!leave` | Leave the voice channel |
| `!ping` | Show current voice latency and region |
| `!pardon @user` | Clear a member's strikes (needs Manage Server) |
| `!help` | List commands |

## Setup

Requires **Node.js 22.12 or newer**.

1. Create an app at the [Discord Developer Portal](https://discord.com/developers/applications), open the **Bot** tab and copy the token.
2. On the same tab, turn on **Server Members Intent** and **Message Content Intent**.
3. Invite the bot (OAuth2 → URL Generator, scope `bot`) with these permissions: View Channels, Connect, Manage Channels, Moderate Members, Move Members, Send Messages, Read Message History.
4. In Server Settings → Roles, drag the bot's role **above** the roles of people it may need to time out.
5. Install and configure:
   ```bash
   npm install
   cp .env.example .env     # Windows: copy .env.example .env
   ```
   Edit `.env` and set `DISCORD_TOKEN`.
6. Run:
   ```bash
   npm start
   ```

## Configuration

Environment variables (`.env`):

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | none | Your bot token (required) |
| `ALERT_CHANNEL_ID` | `1561488774393892956` | Channel where alerts are posted |
| `PREFIX` | `!` | Command prefix |
| `AUTO_TIMEOUT` | `true` | `false` = only alert and switch region |

Thresholds live in `src/config.js`: `lagThresholdMs`, `strikesBeforeSwitch`, `checkIntervalMs`, `switchCooldownMs`, `suspectWindowMs`, `strikesForTimeout`, `timeoutHours`, and the `regions` list.

## Limits

- It only works while the bot is in the call, and measures the **bot's** connection to the voice server, not each user's connection.
- One voice channel per server can be watched at a time (Discord limits bots to one voice connection per server).
- Persistent abuse (voice-crasher tools, etc.) breaks Discord's Terms of Service. Report the user's ID and the alert timestamps to Discord Trust & Safety.
- Strikes are kept in memory and reset when the bot restarts.

## Putting it on GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/vcguard.git
git push -u origin main
```

`.env` is in `.gitignore`, so your token is never uploaded. If you ever commit your token by accident, reset it in the Developer Portal right away.

## License

MIT
