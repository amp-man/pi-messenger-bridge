import type { ITransportProvider } from "./interface.js";
import type { ExternalMessage } from "../types.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import qrcode from "qrcode-terminal";
import * as fs from "fs";
import * as path from "path";

// Dynamic import for ESM modules
type WASocket = any;

async function loadBaileys() {
  const baileys = await import("@whiskeysockets/baileys");
  return baileys;
}

/**
 * WhatsApp transport provider using @whiskeysockets/baileys
 */
export class WhatsAppProvider implements ITransportProvider {
  readonly type = "whatsapp";
  private socket: WASocket | null = null;
  private _isConnected = false;
  private authPath: string;
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private lastProcessedMessageId = "";
  private debug: boolean;
  private isManualConnect = false;
  onDisplay?: (message: string) => void;

  constructor(
    private config: { authPath?: string; debug?: boolean },
    private auth: ChallengeAuth
  ) {
    // Default auth path to ~/.pi/msg-bridge-whatsapp-auth
    this.authPath = config.authPath || path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".pi",
      "msg-bridge-whatsapp-auth"
    );
    this.debug = config.debug || false;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(manual: boolean = false): Promise<void> {
    if (this._isConnected) return;
    this.isManualConnect = manual;

    const display = (message: string): void => {
      if (this.onDisplay) {
        this.onDisplay(message);
        return;
      }

      console.log(message);
    };

    // Ensure auth directory exists
    if (!fs.existsSync(this.authPath)) {
      fs.mkdirSync(this.authPath, { recursive: true, mode: 0o700 });
    } else {
      // Ensure existing directory has secure permissions
      try {
        fs.chmodSync(this.authPath, 0o700);
      } catch (err) {
        display(`⚠️ Failed to set auth directory permissions: ${(err as Error).message}`);
      }
    }

    const baileys = await loadBaileys();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authPath);
    // Fetch latest WA Web version to avoid 405 "Method Not Allowed" from stale bundled version
    let waWebVersion: [number, number, number] | undefined;
    try {
      const { version } = await baileys.fetchLatestWaWebVersion({});
      waWebVersion = version;
    } catch (err) {
      // Fall back to bundled default if fetch fails
    }
    // Suppress Baileys logger unless debug mode
    const silentLogger: any = {
      level: 'silent' as const,
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };
    this.socket = baileys.default({
      auth: state,
      ...(waWebVersion ? { version: waWebVersion } : {}),
      printQRInTerminal: false, // We'll handle QR display ourselves
      logger: this.debug ? undefined : silentLogger,
    });

    // Handle connection updates - set up IMMEDIATELY after socket creation
    this.socket.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (this.debug) {
        console.log("[WhatsApp] connection.update event received:", JSON.stringify(update, null, 2));
      }

      if (qr && this.isManualConnect) {
        qrcode.generate(qr, { small: true }, (qrString: string) => {
          display(`📱 Scan this WhatsApp QR code:\n${qrString}`);
        });
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut;

        if (this.debug) {
          console.log(`[WhatsApp] Connection closed. Status: ${statusCode}, Reconnect: ${shouldReconnect}`);
        }

        this._isConnected = false;

        // If unauthorized (401), clear invalid auth
        if (statusCode === 401) {
          try {
            if (fs.existsSync(this.authPath)) {
              fs.rmSync(this.authPath, { recursive: true, force: true });
              if (this.isManualConnect) {
                display("🔄 WhatsApp session expired. Reconnecting with a fresh QR code...");
                // Reconnect after clearing auth to get fresh QR (manual configure only)
                setTimeout(() => this.connect(true), 1000);
              } else {
                display("🔄 WhatsApp session expired. Run /msg-bridge configure whatsapp to reconnect.");
              }
            }
          } catch (err) {
            display(`❌ Failed to clear auth: ${(err as Error).message}`);
          }
        } else if (shouldReconnect) {
          // Reconnect after 3 seconds
          setTimeout(() => this.connect(), 3000);
        } else if (this.debug) {
          console.warn("⚠️ WhatsApp logged out. Run /msg-bridge configure whatsapp to reconnect.");
        }
      } else if (connection === "open") {
        this._isConnected = true;
        display("✅ WhatsApp connected!");
      }
    });

    // Save credentials when updated
    this.socket.ev.on("creds.update", saveCreds);

    // Handle incoming messages
    this.socket.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify") {
        return;
      }

      for (const msg of messages) {
        await this.handleMessage(msg);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected || !this.socket) return;

    this.socket.end(undefined);
    this.socket = null;
    this._isConnected = false;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.socket) {
      throw new Error("WhatsApp not connected");
    }

    await this.socket.sendMessage(chatId, { text });
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.socket) return;

    try {
      await this.socket.sendPresenceUpdate("composing", chatId);
      // Auto-stop composing after 3 seconds
      setTimeout(async () => {
        try {
          await this.socket?.sendPresenceUpdate("paused", chatId);
        } catch {
          // Ignore
        }
      }, 3000);
    } catch (error) {
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private async handleMessage(msg: any): Promise<void> {
    // Debug: log message structure
    if (this.debug) {
      console.log("[WhatsApp] Message received:", JSON.stringify(msg, null, 2));
    }

    // Skip non-text messages
    const text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!text) {
      return;
    }

    const messageId = msg.key.id || String(Date.now());

    // Filter out old/duplicate messages
    if (messageId === this.lastProcessedMessageId) {
      return;
    }
    this.lastProcessedMessageId = messageId;

    const chatId = msg.key.remoteJid || "";
    // Try multiple fields for username
    const pushName = msg.pushName || msg.verifiedBizName || msg.key.fromMe ? "You" : "Unknown";

    // Skip status broadcasts
    if (chatId === "status@broadcast") {
      return;
    }

    // Detect if DM or group
    // Group JIDs end with @g.us, individual JIDs end with @s.whatsapp.net
    const isGroupChat = chatId.endsWith("@g.us");
    const userId = chatId.split("@")[0]; // Phone number

    // For WhatsApp, mentions work differently - we'll consider it as not mentioned for now
    const wasMentioned = false;

    // Check authorization
    const sendMessageToUser = async (cId: string, text: string) => {
      if (this.socket) {
        await this.socket.sendMessage(cId, { text });
      }
    };

    const isAuthorized = await this.auth.checkAuthorization(
      userId,
      chatId,
      pushName,
      isGroupChat,
      wasMentioned,
      sendMessageToUser,
      this.type
    );

    // Handle admin commands and challenge codes in DM
    if (!isGroupChat && (text.startsWith("/") || text.match(/^\d{6}$/))) {
      const handled = await this.auth.handleAdminCommand(
        text,
        chatId,
        userId,
        async (text) => await this.sendMessage(chatId, text),
        this.type
      );
      if (handled) {
        return;
      }
    }

    if (!isAuthorized) {
      return; // Auth handler already sent challenge/error messages
    }

    // Forward to message handler
    if (this.messageHandler) {
      const externalMessage: ExternalMessage = {
        chatId,
        transport: this.type,
        content: text.trim(),
        username: pushName,
        userId,
        timestamp: new Date(Number(msg.messageTimestamp) * 1000),
        messageId,
        isGroupChat,
        wasMentioned,
      };

      this.messageHandler(externalMessage);
    }
  }
}
