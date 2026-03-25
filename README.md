# pi-messenger-bridge

Bridge common messengers (Telegram, WhatsApp, Slack, Discord) into pi.

Remote users can interact with your pi coding agent via their messenger app.

<img width="887" height="656" alt="image" src="https://github.com/user-attachments/assets/d42a41e5-e7d5-420b-be8e-f2191facb190" />

https://github.com/user-attachments/assets/cd64360e-e8cd-4820-a67f-bd127c5d6035

## Features

- 📱 Multi-messenger support (Telegram, WhatsApp, Slack, Discord)
- 🔐 Challenge-based authentication (6-digit codes)
- 🎛️ Interactive menu (`/msg-bridge`) for setup and management
- 🔒 Single-instance guard — prevents duplicate bot polling with sub-agents
- 📊 Live status widget (toggleable)
- 💾 Persistent config (auth state, auto-connect, widget preference)
- 🔧 Tool call visibility for remote users
- 📝 Multi-turn conversation support
- 🔑 Secure permissions (chmod 600 for config files, 700 for directories)

## Setup

### 1. Install

```bash
pi install npm:pi-messenger-bridge
```

### 2. Configure Transports

#### Telegram

Create a bot via [@BotFather](https://t.me/BotFather) and get your token.

```bash
/msg-bridge configure telegram <bot-token>
```

Or set via environment variable:
```bash
export PI_TELEGRAM_TOKEN="your-bot-token-here"
```

#### WhatsApp

Configure WhatsApp (requires QR code scan):

```bash
/msg-bridge configure whatsapp
```

Scan the QR code with your WhatsApp mobile app (**Linked Devices → Link a device**).

> **Note:** After linking, **send a message to your own phone number** in WhatsApp to activate the bridge.

Or set custom auth path:
```bash
export PI_WHATSAPP_AUTH_PATH="/path/to/whatsapp-auth"
```

#### Slack

Create a Slack app with Socket Mode enabled. You need both tokens:

```bash
/msg-bridge configure slack <bot-token> <app-token>
```

Or set via environment variables:
```bash
export PI_SLACK_BOT_TOKEN="xoxb-..."
export PI_SLACK_APP_TOKEN="xapp-..."
```

#### Discord

1. Create a new application in the [Developer Portal](https://discord.com/developers/applications)
2. Go to **Bot** → **Reset Token** → copy the token
3. Enable **Message Content Intent** (under Privileged Gateway Intents on the same page)
4. Go to **OAuth2 → URL Generator** → select scope `bot` → select permissions `Send Messages` and `Read Message History` → open the generated URL to invite the bot to your server

```bash
/msg-bridge configure discord <bot-token>
```

Or set via environment variable:
```bash
export PI_DISCORD_TOKEN="your-bot-token"
```

### 3. Connect

```bash
/msg-bridge connect
```

### 4. Authenticate Users

When a user messages your bot for the first time, they'll receive a 6-digit challenge code.
The code is displayed in your pi terminal. Share it with the user (e.g., via DM).

The user enters the code in the bot chat to become a trusted user.

## Commands

| Command | Description |
|---|---|
| `/msg-bridge` | Open interactive menu (configure, connect, widget, help) |
| `/msg-bridge status` | Show connection and user status |
| `/msg-bridge connect` | Connect to all configured transports |
| `/msg-bridge disconnect` | Disconnect all transports |
| `/msg-bridge configure <platform> [token]` | Set transport credentials via CLI |
| `/msg-bridge widget` | Toggle status widget on/off |
| `/msg-bridge help` | Show command reference |

## Configuration

Config is stored at `~/.pi/msg-bridge.json` with secure permissions (chmod 600).

Example config:
```json
{
  "telegram": { "token": "..." },
  "whatsapp": { "authPath": "..." },
  "slack": { "botToken": "...", "appToken": "..." },
  "discord": { "token": "..." },
  "auth": {
    "trustedUsers": ["telegram:123", "whatsapp:456"],
    "adminUserId": "telegram:789"
  },
  "autoConnect": true,
  "showWidget": true,
  "debug": false
}
```

## Environment Variables

Environment variables override file config:

- `PI_TELEGRAM_TOKEN` — Telegram bot token
- `PI_WHATSAPP_AUTH_PATH` — WhatsApp session directory (default: `~/.pi/msg-bridge-whatsapp-auth`)
- `PI_SLACK_BOT_TOKEN` — Slack bot token (xoxb-...)
- `PI_SLACK_APP_TOKEN` — Slack app token (xapp-...)
- `PI_DISCORD_TOKEN` — Discord bot token
- `MSG_BRIDGE_DEBUG` — Enable debug logging (true/false)

## Security

- Config file: `~/.pi/msg-bridge.json` (chmod 600 - owner read/write only)
- Config directory: `~/.pi/` (chmod 700 - owner only)
- WhatsApp auth: `~/.pi/msg-bridge-whatsapp-auth/` (chmod 700 - owner only)
- Environment variables take precedence over config file
- Challenge-based authentication for all new users
- Transport-namespaced user IDs prevent impersonation

## Troubleshooting

Enable debug mode to see detailed logs:

```json
{
  "debug": true
}
```

Or:
```bash
export MSG_BRIDGE_DEBUG=true
```

## Architecture

Uses pi's native `sendUserMessage()` and `turn_end` events for two-way communication.
No tool-loop hacks needed — this is the pi-native way.

Single-instance connection guard prevents duplicate polling when sub-agents spawn
(global flag + PID lock file at `~/.pi/msg-bridge.lock`).

## Development

```bash
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run test         # run tests
npm run lint         # biome lint
npm run lint:fix     # biome lint with auto-fix
```

## License

MIT
