# Local Discord Setup

The Discord integration targets one local server, one Discord guild, and one
active Diplomacy game. The browser remains the interface for the map, orders,
hosting, Discord linking, and voice controls. This is an optional private/local
integration. Showcase deployments reject enabling Discord or voice, load neither
integration nor SDK, and register none of their browser handlers.

Browser linking and voice hooks require a signed-in operator configured with
`DIPLOMACY_ADMIN_GITHUB_USER_IDS`; hosting a room does not grant that role. See
[authentication](authentication.md). Ordinary players cannot create link codes.
Supporting broader private Discord participation is deferred work (DIC-75).

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
Select `DIPLOMACY_PROFILE=private` (or `local`) and explicitly set
`DISCORD_ENABLED=true`. Supply `DISCORD_GUILD_ID` and
`DISCORD_COORDINATOR_TOKEN`. Tokens alone do not enable anything. Power bots
without tokens remain disabled and log a startup warning. Disabled integrations
need no Discord secrets, do not read those credentials or construct clients, and
have no browser handlers or controls.

Keep voice disabled during initial text testing:

```env
DISCORD_VOICE_ENABLED=false
```

Voice additionally requires all seven power-bot tokens, `OPENAI_API_KEY`, and
explicit paid-provider enablement. Paid startup remains interlocked until the
budget/admission implementation is integrated. Keep voice disabled for MVP
verification: the retained implementation and flow below are for future private
use; voice repair and paid voice testing are outside the showcase MVP.

Voice sessions auto-listen by default after the linked player joins the
temporary voice channel, commit after the lobby-configured silence threshold,
and end when the linked player leaves. Disable that behavior only when testing
manual controls:

```env
DISCORD_VOICE_AUTO_LISTEN=false
```

Verbose Discord voice handshake and receive diagnostics are hidden by default.
Enable them only while debugging:

```env
DISCORD_VOICE_DEBUG=true
```

The server uses the current DAVE-capable `@discordjs/voice` release,
`prism-media`, and `opusscript`. Node.js 22.16 or newer is required.

## Linking Flow

1. Create a browser game.
2. As an authenticated operator and room host, choose **Create server bind code** in the Discord panel.
3. In Discord, run `/game bind code:<code>` with the coordinator.
4. Each operator playing a human seat chooses **Create player link code** in the browser.
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

OpenAI server-side VAD is disabled. In the default auto-listen mode, the
browser still starts the session, but the server begins listening when the
linked Discord account joins the temporary channel and commits after the player
stops speaking. Manual **Listen** and **Done** controls remain available as a
fallback. Final human and assistant transcripts become private diplomatic
messages. Raw audio is not persisted.

An operator who hosts the room can configure session duration, turn count, and idle timeout in the
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
- If automatic movement into the temporary voice channel fails with
  `Missing Permissions`, confirm the user is already connected to a voice
  channel, the coordinator role has Move Members, and the coordinator's highest
  role is above the target user's highest role. Discord does not allow bots to
  move the server owner.
- If playback fails, run on Node.js 22.16 or newer and reinstall dependencies
  so the Opus backend is available.

## Current Boundary

Bindings, links, games, transcripts, and voice sessions are in memory. Durable
recovery, multi-guild operation, deployment migration, moderation policy, and
audio recording are intentionally separate milestones.
