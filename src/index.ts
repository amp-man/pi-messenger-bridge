import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig, saveConfig } from "./config.js";
import { extractTextFromMessage, formatToolCalls, hasToolCalls, splitMessage } from "./formatting.js";
import { acquireLock, releaseLock } from "./lock.js";
import { DiscordProvider } from "./transports/discord.js";
import { TransportManager } from "./transports/manager.js";
import { SlackProvider } from "./transports/slack.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";
import type { MsgBridgeConfig, PendingRemoteChat, TransportStatus } from "./types.js";
import { openMainMenu } from "./ui/main-menu.js";
import { createStatusWidget } from "./ui/status-widget.js";

/**
 * pi-remote-pilot extension
 * Bridges messenger apps (Telegram, WhatsApp, Slack, Discord) into pi
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;

  function _timeAgo(epochMs: number): string {
    const seconds = Math.floor((Date.now() - epochMs) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(epochMs).toLocaleDateString();
  }

  /**
  /**
   * Update status widget
   */
  function updateWidget(): void {
    const config = loadConfig();

    if (config.showWidget === false) {
      ctx.ui.setWidget("msg-bridge-status", undefined);
      return;
    }

    const stats = auth.getStats();
    const transports: TransportStatus[] = transportManager
      .getStatus()
      .map((s) => ({
        type: s.type,
        connected: s.connected,
      }));

    const widget = createStatusWidget(transports, stats.usersByTransport);
    if (widget) {
      ctx.ui.setWidget("msg-bridge-status", [widget]);
    } else {
      ctx.ui.setWidget("msg-bridge-status", undefined);
    }
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  /**
   * Initialize extension
   */
  pi.on("session_start", async (_event, context) => {
    ctx = context;

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        ctx.ui.notify(
          `🔐 Challenge code for @${username}: ${code}`,
          "info"
        );
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the transport's sendMessage
      },
      saveAuthState
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Initialize transports in the background (non-blocking)
    (async () => {
      const transportPromises: Promise<void>[] = [];

      if (config.telegram?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const telegramProvider = new TelegramProvider(config.telegram!.token, auth);
            transportManager.addTransport(telegramProvider);
          })
        );
      }

      if (config.whatsapp) {
        const whatsappAuthPath = config.whatsapp.authPath || path.join(
          os.homedir(),
          ".pi",
          "msg-bridge-whatsapp-auth"
        );

        const credsPath = path.join(whatsappAuthPath, "creds.json");
        if (fs.existsSync(credsPath)) {
          transportPromises.push(
            Promise.resolve().then(() => {
              const whatsappConfig = { ...config.whatsapp!, debug: config.debug };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              whatsappProvider.onDisplay = (msg) => ctx.ui.notify(msg, "info");
              transportManager.addTransport(whatsappProvider);
            })
          );
        } else {
          delete config.whatsapp;
          saveConfig(config);
        }
      }

      if (config.slack?.botToken && config.slack?.appToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const slackProvider = new SlackProvider(config.slack!, auth);
            transportManager.addTransport(slackProvider);
          })
        );
      }

      if (config.discord?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const discordProvider = new DiscordProvider(config.discord!, auth);
            transportManager.addTransport(discordProvider);
          })
        );
      }

      await Promise.all(transportPromises);

      // Auto-connect if configured
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && config.autoConnect !== false) {
        if (!acquireLock()) {
          ctx.ui.notify("ℹ️ msg-bridge: another instance is already connected — skipping auto-connect", "info");
        } else {
          try {
            await transportManager.connectAll();
            updateWidget();
          } catch (err) {
            releaseLock();
            ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
          }
        }
      }
    })().catch(err => {
      console.error("Transport initialization error:", err);
      ctx.ui.notify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

    transportManager.onMessage((msg) => {
      pendingRemoteChat = {
        chatId: msg.chatId,
        transport: msg.transport,
        username: msg.username,
        messageId: msg.messageId,
      };

      // Auto-capture contact details for proactive messaging
      try {
        const configPath = path.join(os.homedir(), ".pi", "msg-bridge.json");
        const config: MsgBridgeConfig = fs.existsSync(configPath)
          ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
          : {};
        const knownContacts = config.knownContacts ?? [];
        const existingContact = knownContacts.find(
          (contact: any) => contact.transport === msg.transport && contact.chatId === msg.chatId
        );
        const now = Date.now();
        if (existingContact) {
          existingContact.username = msg.username;
          existingContact.lastSeen = now;
        } else {
          knownContacts.push({
            transport: msg.transport,
            chatId: msg.chatId,
            username: msg.username,
            lastSeen: now,
          });
        }
        config.knownContacts = knownContacts;
        saveConfig(config);
      } catch (err) {
        console.error("Failed to update known contacts:", err);
      }

      // Inject message into pi as a user message (triggers agent turn)
      const taggedMessage = `📱 **@${msg.username} via ${msg.transport}**: ${msg.content}`;
      pi.sendUserMessage(taggedMessage, { deliverAs: "steer" });
    });

    transportManager.onError((err, transport) => {
      ctx.ui.notify(`❌ ${transport} error: ${err.message}`, "error");
    });

    updateWidget();
  });

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async (_event, _context) => {
    if (pendingRemoteChat) {
      try {
        await transportManager.sendTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport
        );
      } catch (_err) {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Handle turn end - send response back to messenger
   */
  pi.on("turn_end", async (event, _context) => {
    if (!pendingRemoteChat) return;

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message, pendingRemoteChat);
      const hasPendingTools = hasToolCalls(message);

      const parts: string[] = [];
      if (responseText) parts.push(responseText);
      if (toolCallsText) parts.push(toolCallsText);

      if (parts.length === 0) return;

      const fullText = parts.join("\n\n");

      // Split long messages for Telegram's 4096 char limit
      const chunks = splitMessage(fullText, 4000);
      for (const chunk of chunks) {
        await transportManager.sendMessage(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          chunk
        );
      }

      if (!hasPendingTools) {
        pendingRemoteChat = null;
      }
    } catch (err) {
      const transport = pendingRemoteChat?.transport ?? "unknown";
      ctx.ui.notify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      pendingRemoteChat = null;
    }
  });

  /**
   * Cleanup on session exit — release lock and disconnect transports
   */
  pi.on("session_shutdown", async (_event, _context) => {
    await transportManager.disconnectAll();
    releaseLock();
  });

  /**
   * /msg-bridge command - show status or manage connections
   */
  pi.registerCommand("msg-bridge", {
    description: "Manage remote messenger connections (help|status|connect|disconnect|configure|widget|alias|unalias)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "";

    // No subcommand → open interactive menu
    if (!subcommand || subcommand === "menu") {
      await openMainMenu({
        ui: context.ui,
        transportManager,
        auth,
        updateWidget,
      });
      return;
    }

    switch (subcommand) {
      case "help": {
        const helpText = [
          "━━━ Message Bridge Commands ━━━",
          "",
          "/msg-bridge                   Open interactive menu",
          "/msg-bridge help              Show this help",
          "/msg-bridge status            Show connection and user status",
          "/msg-bridge connect           Connect to all transports",
          "/msg-bridge disconnect        Disconnect from all transports",
          "/msg-bridge configure telegram <token>",
          "                              Configure Telegram bot",
          "/msg-bridge configure whatsapp",
          "                              Configure WhatsApp (scan QR)",
          "/msg-bridge alias <name> [transport:chatId]",
          "                              Set alias on a contact (by username or transport:chatId)",
          "/msg-bridge unalias <name>    Remove an alias from a contact",
          "/msg-bridge widget            Toggle status widget on/off",
          "LLM tool: send_remote_message(alias, text) for proactive messaging",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ];
        context.ui.notify(helpText.join("\n"), "info");
        break;
      }
      case "connect":
        if (!acquireLock()) {
          context.ui.notify("⚠️ Another msg-bridge instance is already connected. Run /msg-bridge disconnect there first.", "warning");
          break;
        }
        try {
          await transportManager.connectAll();
          const cfg = loadConfig();
          cfg.autoConnect = true;
          saveConfig(cfg);
          context.ui.notify("✅ Connected to all configured transports", "info");
          updateWidget();
        } catch (err) {
          releaseLock();
          context.ui.notify(
            `❌ Connection failed: ${(err as Error).message}`,
            "error"
          );
        }
        break;

      case "disconnect": {
        await transportManager.disconnectAll();
        releaseLock();
        const cfg = loadConfig();
        cfg.autoConnect = false;
        saveConfig(cfg);
        context.ui.notify("🔌 Disconnected from all transports", "info");
        updateWidget();
        break;
      }

      case "configure": {
        const platform = parts[1];
        const token = parts.slice(2).join(" ");

        if (!platform) {
          context.ui.notify("Usage: /msg-bridge configure <platform> [token/path]", "error");
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "telegram": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure telegram <bot-token>", "error");
              return;
            }
            config.telegram = { token };
            saveConfig(config);
            const telegramProvider = new TelegramProvider(token, auth);
            transportManager.addTransport(telegramProvider);
            if (acquireLock()) {
              try {
                await telegramProvider.connect();
                context.ui.notify("✅ Telegram configured and connected", "info");
              } catch (_err) {
                releaseLock();
                context.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
              }
            } else {
              context.ui.notify("✅ Telegram configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "whatsapp": {
            config.whatsapp = token ? { authPath: token } : {};
            saveConfig(config);
            const whatsappConfig = { ...config.whatsapp, debug: config.debug };
            const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
            whatsappProvider.onDisplay = (msg) => ctx.ui.notify(msg, "info");
            transportManager.addTransport(whatsappProvider);
            if (acquireLock()) {
              try {
                await whatsappProvider.connect(true);
                context.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ WhatsApp configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "slack": {
            const parts2 = token.split(/\s+/);
            const botToken = parts2[0];
            const appToken = parts2[1];

            if (!botToken || !appToken) {
              context.ui.notify("Usage: /msg-bridge configure slack <bot-token> <app-token>", "error");
              return;
            }

            config.slack = { botToken, appToken };
            saveConfig(config);
            const slackProvider = new SlackProvider(config.slack, auth);
            transportManager.addTransport(slackProvider);
            if (acquireLock()) {
              try {
                await slackProvider.connect();
                context.ui.notify("✅ Slack configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Slack configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "discord": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure discord <bot-token>", "error");
              return;
            }

            config.discord = { token };
            saveConfig(config);
            const discordProvider = new DiscordProvider(config.discord, auth);
            transportManager.addTransport(discordProvider);
            if (acquireLock()) {
              try {
                await discordProvider.connect();
                context.ui.notify("✅ Discord configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Discord configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          default:
            context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
        }
        break;
      }

      case "alias": {
        const aliasName = parts[1];
        const target = parts.slice(2).join(" ").trim();

        if (!aliasName) {
          context.ui.notify("Usage: /msg-bridge alias <name> [transport:chatId|username]", "error");
          return;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(aliasName)) {
          context.ui.notify("❌ Alias must use only letters, numbers, underscores, or hyphens", "error");
          return;
        }

        const cfg = loadConfig();
        const contacts = cfg.knownContacts ?? [];

        // Find the contact to alias
        let contact;
        if (target && target.includes(":")) {
          const sep = target.indexOf(":");
          const transport = target.substring(0, sep).trim();
          const chatId = target.substring(sep + 1).trim();
          contact = contacts.find((c) => c.transport === transport && c.chatId === chatId);
          if (!contact) {
            // Create a new contact entry for a transport:chatId we haven't seen yet
            contact = { transport, chatId, username: aliasName, lastSeen: 0 };
            contacts.push(contact);
          }
        } else {
          const lookup = target || aliasName;
          contact = contacts.find(
            (c) => c.username.toLowerCase() === lookup.toLowerCase()
                || c.alias?.toLowerCase() === lookup.toLowerCase()
          );
        }

        if (!contact) {
          const list = contacts.length > 0
            ? contacts.map((c) => `  └─ ${c.username} (${c.transport}:${c.chatId})`).join("\n")
            : "  (none — send a message from a messenger first)";
          context.ui.notify(`❌ Contact '${target || aliasName}' not found.\nKnown contacts:\n${list}`, "error");
          return;
        }

        contact.alias = aliasName;
        cfg.knownContacts = contacts;
        saveConfig(cfg);
        context.ui.notify(`✅ Alias '${aliasName}' set on ${contact.username} (${contact.transport}:${contact.chatId})`, "info");
        break;
      }

      case "unalias": {
        const aliasName = parts[1];
        if (!aliasName) {
          context.ui.notify("Usage: /msg-bridge unalias <name>", "error");
          return;
        }
        const cfg = loadConfig();
        const contacts = cfg.knownContacts ?? [];
        const contact = contacts.find((c) => c.alias === aliasName);
        if (!contact) {
          context.ui.notify(`❌ No contact with alias '${aliasName}'`, "error");
          return;
        }
        delete contact.alias;
        cfg.knownContacts = contacts;
        saveConfig(cfg);
        context.ui.notify(`✅ Removed alias '${aliasName}' from ${contact.username}`, "info");
        break;
      }
      case "widget": {
        const cfg2 = loadConfig();
        cfg2.showWidget = cfg2.showWidget === false;
        saveConfig(cfg2);
        const widgetState = cfg2.showWidget !== false ? "shown" : "hidden";
        context.ui.notify(`📊 Status widget ${widgetState}`, "info");
        updateWidget();
        break;
      }
      case "status": {
        const stats = auth.getStats();
        const status = transportManager.getStatus();
        const lines = [
          "━━━ Message Bridge Status ━━━",
          "",
          "Transports:",
          ...status.map(
            (s) => `  ${s.connected ? "●" : "○"} ${s.type}`
          ),
          "",
          `Trusted Users: ${stats.trustedUsers}`,
        ];

        if (stats.trustedUsers > 0) {
          for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
            if (userIds.length > 0) {
              lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
            }
          }
        }

        lines.push("");
        lines.push(`Channels: ${stats.channels}`);
        const cfg = loadConfig();
        const contacts = cfg.knownContacts ?? [];

        lines.push("");
        if (contacts.length > 0) {
          const sorted = [...contacts].sort((a, b) => b.lastSeen - a.lastSeen);
          lines.push(`Contacts: ${sorted.length}`);
          for (const c of sorted) {
            const name = c.username || "(unknown)";
            const ago = c.lastSeen > 0 ? _timeAgo(c.lastSeen) : "never seen";
            const aliasTag = c.alias ? ` [alias: ${c.alias}]` : "";
            lines.push(`  └─ ${name} (${c.transport}:${c.chatId}) — ${ago}${aliasTag}`);
          }
        } else {
          lines.push("Contacts: (none)");
        }
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        context.ui.notify(lines.join("\n"), "info");
        break;
      }
      default:
        context.ui.notify(`Unknown subcommand: ${subcommand}. Run /msg-bridge help`, "warning");
        break;
    }
    },
  });

  pi.registerTool({
    name: "send_remote_message",
    label: "Send Remote Message",
    description:
      "Send a proactive message to a contact by alias or username. Use /msg-bridge status to see contacts.",
    parameters: Type.Object({
      alias: Type.String({ description: "Contact alias or username" }),
      text: Type.String({ description: "Message text to send" }),
    }),
    async execute(_toolCallId, params) {
      const config = loadConfig();
      const lookup = params.alias.trim().toLowerCase();
      const contacts = config.knownContacts ?? [];

      // Find by alias first, then by username
      const contact = contacts.find((c) => c.alias?.toLowerCase() === lookup)
                   || contacts.find((c) => c.username.toLowerCase() === lookup);

      if (!contact) {
        const available = contacts
          .map((c) => c.alias || c.username)
          .filter(Boolean)
          .sort();
        const list = available.length > 0 ? available.join(", ") : "(none)";

        return {
          content: [{ type: "text", text: `❌ Contact '${params.alias}' not found. Available: ${list}` }],
          details: {},
          isError: true,
        };
      }
      const messageText = params.text;
      if (!messageText.trim()) {
        return {
          content: [{ type: "text", text: "❌ Message text cannot be empty." }],
          details: {},
          isError: true,
        };
      }

      try {
        const chunks = splitMessage(messageText, 4000);
        for (const chunk of chunks) {
          await transportManager.sendMessage(contact.chatId, contact.transport, chunk);
        }

        const label = contact.alias || contact.username;
        return {
          content: [{ type: "text", text: `✅ Sent message to '${label}' via ${contact.transport}.` }],
          details: {},
        };
      } catch (err) {
        const label = contact.alias || contact.username;
        return {
          content: [{ type: "text", text: `❌ Failed to send to '${label}': ${(err as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
