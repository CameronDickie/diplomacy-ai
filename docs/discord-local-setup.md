# Local Discord Setup

The Discord integration targets one local server, one Discord guild, and one
active Diplomacy game. The browser remains the interface for the map, orders,
hosting, Discord linking, and voice controls.

## Applications

Create eight applications in the Discord Developer Portal:

1. Diplomacy Coordinator
2. Austria
3. England
4. France
5. Germany
6. Italy
7. Russia
8. Turkey

Add a bot user to every application. Enable the Message Content intent for each
power bot. The coordinator uses guild slash commands and does not read ordinary
messages.

Install all eight bots in the same development guild:

- Coordinator: `bot` and `applications.commands` scopes; View Channels, Send
  Messages, Manage Channels, Connect, and Move Members permissions.
- Power bots: `bot` scope; View Channels, Send Messages, Connect, and Speak
  permissions.

Users must allow direct messages from server members so they can message the
power bots.

## Environment

Copy the Discord variables from `.env.example` into the server environment.
`DISCORD_GUILD_ID` and `DISCORD_COORDINATOR_TOKEN` enable text integration.
Power bots without tokens remain disabled and log a startup warning.

Keep voice disabled during initial text testing:

```env
DISCORD_VOICE_ENABLED=false
```

Voice additionally requires `OPENAI_API_KEY`. Enable it only after all bots
connect successfully:

```env
DISCORD_VOICE_ENABLED=true
```

The server uses the current DAVE-capable `@discordjs/voice` release,
`prism-media`, and `opusscript`. Node.js 22.12 or newer is required.

## Linking Flow

1. Create a browser game.
2. As host, choose **Create server bind code** in the Discord panel.
3. In Discord, run `/game bind code:<code>` with the coordinator.
4. Each human chooses **Create player link code** in the browser.
5. That player runs `/link code:<code>` with the coordinator.
6. The player can now DM any online LLM power bot.

Codes are single-use, expire after ten minutes, and are kept only in memory.
Restarting the server clears the guild binding and all account links.

The coordinator remains online. Power bots are online only when their power is
LLM-controlled in the bound game. Discord presence is global, which is why this
version supports only one configured guild and game.

## Voice Flow

1. Select an LLM conversation in the browser and choose **Start Discord
   voice**.
2. Open the temporary private channel from the browser link.
3. Choose **Start listening**. Only the linked Discord account is captured.
4. Choose **Done speaking** to commit the buffered turn.
5. The power bot streams the OpenAI Realtime response into Discord.
6. Use **Interrupt response** or **End session** when needed.

VAD is disabled. Audio is sent only between **Start listening** and **Done
speaking**. Final human and assistant transcripts become private diplomatic
messages. Raw audio is not persisted.

The host can configure session duration, turn count, and idle timeout in the
lobby. Temporary channels are removed when the session ends or times out.

## Troubleshooting

- A power bot is invisible when the power is human-controlled, not present, or
  its token is missing.
- If DMs are ignored, verify the power bot's Message Content intent and the
  user's server-DM privacy setting.
- If channel creation fails, verify the coordinator has Manage Channels and
  that its highest role is allowed to create permission overwrites.
- If voice input fails, confirm the linked user joined the generated channel,
  `DISCORD_VOICE_ENABLED=true`, and `OPENAI_API_KEY` is present.
- If playback fails, run on Node.js 22.12 or newer and reinstall dependencies
  so the Opus backend is available.

## Current Boundary

Bindings, links, games, transcripts, and voice sessions are in memory. Durable
recovery, multi-guild operation, deployment migration, moderation policy, and
audio recording are intentionally separate milestones.
