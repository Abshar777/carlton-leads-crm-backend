/**
 * WhatsApp Service — Multi-user Baileys integration
 * ─────────────────────────────────────────────────────────────────────────────
 * Each CRM user connects their own WhatsApp account.
 * Sessions are stored per-user in ./whatsapp-sessions/{userId}/
 * Unknown contacts emit whatsapp:unknown_contact to the user's socket room
 * instead of auto-creating leads (user decides via the portal).
 */

import path from "path";
import fs from "fs";
import pino from "pino";
import qrcode from "qrcode";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  type proto,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const MEDIA_DIR = path.resolve("uploads/whatsapp-media");
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

import { Lead }               from "../models/Lead.js";
import { WhatsAppMessage }    from "../models/WhatsAppMessage.js";
import { WhatsAppSettings }   from "../models/WhatsAppSettings.js";
import { emitToUser }         from "../socket.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

export interface WAStatusPayload {
  status:   WAStatus;
  phone?:   string;
  qrImage?: string;
}

interface UserWASession {
  sock:           WASocket | null;
  status:         WAStatus;
  phone:          string;
  qrImage:        string;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// ── Per-user session store ────────────────────────────────────────────────────

const sessions = new Map<string, UserWASession>();

function getSession(userId: string): UserWASession {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      sock:           null,
      status:         "disconnected",
      phone:          "",
      qrImage:        "",
      reconnectTimer: null,
    });
  }
  return sessions.get(userId)!;
}

const logger = pino({ level: "silent" });

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

function toJID(phone: string): string {
  const digits = normalisePhone(phone);
  const withCC = digits.length === 10 ? `91${digits}` : digits;
  return `${withCC}@s.whatsapp.net`;
}

function extractBody(msg: proto.IMessage): string {
  if (msg.conversation)               return msg.conversation;
  if (msg.extendedTextMessage?.text)  return msg.extendedTextMessage.text;
  if (msg.imageMessage)               return msg.imageMessage.caption || "📷 Photo";
  if (msg.videoMessage)               return msg.videoMessage.caption || "🎥 Video";
  if (msg.audioMessage)               return msg.audioMessage.ptt    ? "🎤 Voice note" : "🎵 Audio";
  if (msg.documentMessage)            return msg.documentMessage.caption || `📄 ${msg.documentMessage.fileName ?? "Document"}`;
  if (msg.stickerMessage)             return "🔖 Sticker";
  if (msg.locationMessage)            return "📍 Location";
  if (msg.liveLocationMessage)        return "📍 Live Location";
  if (msg.contactMessage)             return `👤 ${msg.contactMessage.displayName ?? "Contact"}`;
  if (msg.reactionMessage)            return `${msg.reactionMessage.text ?? "👍"} Reaction`;
  if (msg.pollCreationMessage)        return `📊 Poll: ${msg.pollCreationMessage.name ?? ""}`;
  if (msg.buttonsResponseMessage)     return msg.buttonsResponseMessage.selectedButtonId ?? "Button response";
  if (msg.listResponseMessage)        return msg.listResponseMessage.title ?? "List response";
  return "[Unsupported message]";
}

function sessionDir(userId: string): string {
  return path.resolve(`whatsapp-sessions/${userId}`);
}

function emitStatus(userId: string) {
  const s = getSession(userId);
  const payload: WAStatusPayload = { status: s.status, phone: s.phone, qrImage: s.qrImage };
  emitToUser(userId, "whatsapp:status", payload);
}

// ── Media helpers ─────────────────────────────────────────────────────────────

type MediaInfo = { mediaUrl: string; mediaType: string; mimeType: string; fileName: string } | null;

async function downloadInboundMedia(
  sock: WASocket,
  msg:  proto.IWebMessageInfo,
): Promise<MediaInfo> {
  const m = msg.message;
  if (!m) return null;

  let mediaType: string;
  let mimeType:  string;
  let fileExt:   string;
  let fileName:  string = "";

  if      (m.imageMessage)    { mediaType = "image";    mimeType = m.imageMessage.mimetype    || "image/jpeg";      fileExt = "jpg"; }
  else if (m.videoMessage)    { mediaType = "video";    mimeType = m.videoMessage.mimetype    || "video/mp4";       fileExt = "mp4"; }
  else if (m.documentMessage) { mediaType = "document"; mimeType = m.documentMessage.mimetype || "application/pdf"; fileExt = mimeType.split("/")[1] || "bin"; fileName = m.documentMessage.fileName || ""; }
  else if (m.audioMessage)    { mediaType = "audio";    mimeType = m.audioMessage.mimetype    || "audio/ogg";       fileExt = "ogg"; }
  else if (m.stickerMessage)  { mediaType = "sticker";  mimeType = m.stickerMessage.mimetype  || "image/webp";      fileExt = "webp"; }
  else return null;

  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const safeId = (msg.key.id ?? Date.now().toString()).replace(/[^a-zA-Z0-9_-]/g, "");
    const fname  = `${safeId}.${fileExt}`;
    fs.writeFileSync(path.join(MEDIA_DIR, fname), buffer as Buffer);
    return { mediaUrl: `/api/v1/whatsapp/media/${fname}`, mediaType, mimeType, fileName };
  } catch (err) {
    console.warn("[WA] Media download failed:", err);
    return null;
  }
}

// ── Incoming message handler ──────────────────────────────────────────────────

async function handleInbound(
  userId: string,
  sock:   WASocket,
  msg:    proto.IWebMessageInfo,
): Promise<void> {
  const jid  = msg.key.remoteJid ?? "";
  const body = extractBody(msg.message!);
  const senderName = msg.pushName ?? "";
  const messageId  = msg.key.id ?? "";

  const phone = normalisePhone(jid.split("@")[0]);
  if (!phone || !body.trim()) return;

  // Deduplicate by messageId
  if (messageId) {
    const exists = await WhatsAppMessage.exists({ messageId });
    if (exists) return;
  }

  const last10 = phone.slice(-10);
  const lead   = await Lead.findOne({ phone: { $regex: last10 } }).lean();

  const settings = await WhatsAppSettings.findOne({ userId }).lean();

  // Download media if present
  const media = await downloadInboundMedia(sock, msg);

  // Save message regardless of lead link
  const saved = await WhatsAppMessage.create({
    lead:            lead?._id ?? null,
    phone,
    direction:       "inbound",
    body:            body.trim(),
    messageId,
    senderName:      senderName || phone,
    connectedUserId: userId,
    read:            false,
    ...(media ?? {}),
  });

  if (!lead) {
    if (settings?.autoCreateLeads) {
      // Auto-create lead mode
      const newLead = await Lead.create({
        name:   senderName || phone,
        phone,
        source: "WhatsApp",
        status: "new",
      });
      await WhatsAppMessage.updateOne({ _id: saved._id }, { $set: { lead: newLead._id } });

      emitToUser(userId, "whatsapp:message", {
        leadId:     newLead._id.toString(),
        leadName:   newLead.name,
        phone,
        body:       body.trim(),
        senderName: senderName || phone,
        direction:  "inbound",
        messageId:  saved._id.toString(),
        timestamp:  saved.createdAt,
      });
    } else {
      // Ask the user — emit unknown contact event
      emitToUser(userId, "whatsapp:unknown_contact", {
        phone,
        senderName: senderName || phone,
        body:       body.trim(),
        messageId:  saved._id.toString(),
        timestamp:  saved.createdAt,
      });
    }
  } else {
    emitToUser(userId, "whatsapp:message", {
      leadId:     lead._id.toString(),
      leadName:   lead.name,
      phone,
      body:       body.trim(),
      senderName: senderName || phone,
      direction:  "inbound",
      messageId:  saved._id.toString(),
      timestamp:  saved.createdAt,
    });
  }
}

// ── Core connect ──────────────────────────────────────────────────────────────

export async function connect(userId: string): Promise<void> {
  const s = getSession(userId);

  if (s.sock) {
    try { await s.sock.logout(); } catch { /* ignore */ }
    s.sock = null;
  }
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }

  s.status  = "connecting";
  s.qrImage = "";
  emitStatus(userId);

  const dir            = sessionDir(userId);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:            state,
    logger,
    printQRInTerminal: false,
    browser:         ["Carlton CRM", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
  });
  s.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      s.status  = "qr_ready";
      s.qrImage = await qrcode.toDataURL(qr).catch(() => "");
      emitStatus(userId);
      console.log(`📱 WhatsApp QR ready — user ${userId}`);
    }

    if (connection === "open") {
      s.status  = "connected";
      s.phone   = (sock.user?.id ?? "").split(":")[0].split("@")[0];
      s.qrImage = "";
      emitStatus(userId);
      console.log(`✅ WhatsApp connected — user ${userId} (${s.phone})`);
    }

    if (connection === "close") {
      const code      = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      s.status = "disconnected";
      if (loggedOut) s.phone = "";
      emitStatus(userId);
      console.log(`🔴 WhatsApp disconnected — user ${userId} code=${code}`);

      if (!loggedOut) {
        s.reconnectTimer = setTimeout(() => connect(userId), 5_000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe)                        continue;
      if (!msg.message)                          continue;
      if (msg.key.remoteJid?.endsWith("@g.us"))  continue; // skip groups

      await handleInbound(userId, sock, msg).catch((err) =>
        console.error(`WhatsApp inbound error (user ${userId}):`, err)
      );
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function disconnectWA(userId: string): Promise<void> {
  const s = getSession(userId);
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.sock) {
    try { await s.sock.logout(); } catch { /* ignore */ }
    s.sock    = null;
    s.status  = "disconnected";
    s.phone   = "";
    s.qrImage = "";
    emitStatus(userId);
  }
}

export async function sendMessage(
  userId:   string,
  phone:    string,
  body:     string,
  agentId?: string,
): Promise<void> {
  const s = getSession(userId);
  if (!s.sock || s.status !== "connected") throw new Error("WhatsApp not connected");

  const jid = toJID(phone);
  await s.sock.sendMessage(jid, { text: body });

  const last10 = normalisePhone(phone).slice(-10);
  const lead   = await Lead.findOne({ phone: { $regex: last10 } }).lean();

  const saved = await WhatsAppMessage.create({
    lead:            lead?._id ?? null,
    phone:           normalisePhone(phone),
    direction:       "outbound",
    body:            body.trim(),
    messageId:       "",
    agentId:         agentId ?? null,
    connectedUserId: userId,
    read:            true,
  });

  emitToUser(userId, "whatsapp:message", {
    leadId:    lead?._id?.toString() ?? null,
    leadName:  lead?.name ?? null,
    phone:     normalisePhone(phone),
    body:      body.trim(),
    direction: "outbound",
    messageId: saved._id.toString(),
    timestamp: saved.createdAt,
  });
}

export async function sendMedia(
  userId:   string,
  phone:    string,
  buffer:   Buffer,
  mimeType: string,
  fileName: string,
  caption:  string,
  agentId?: string,
): Promise<void> {
  const s = getSession(userId);
  if (!s.sock || s.status !== "connected") throw new Error("WhatsApp not connected");

  const jid   = toJID(phone);
  const nPhone = normalisePhone(phone);
  const last10 = nPhone.slice(-10);

  let mediaType: "image" | "video" | "document" | "audio";
  let baileysMsg: Record<string, unknown>;

  if (mimeType.startsWith("image/")) {
    mediaType  = "image";
    baileysMsg = { image: buffer, mimetype: mimeType, caption };
  } else if (mimeType.startsWith("video/")) {
    mediaType  = "video";
    baileysMsg = { video: buffer, mimetype: mimeType, caption };
  } else if (mimeType.startsWith("audio/")) {
    mediaType  = "audio";
    baileysMsg = { audio: buffer, mimetype: mimeType, ptt: false };
  } else {
    mediaType  = "document";
    baileysMsg = { document: buffer, mimetype: mimeType, fileName, caption };
  }

  await s.sock.sendMessage(jid, baileysMsg as Parameters<typeof s.sock.sendMessage>[1]);

  // Save file to disk
  const ext    = fileName.split(".").pop() || mimeType.split("/")[1] || "bin";
  const fname  = `out_${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, fname), buffer);
  const mediaUrl = `/api/v1/whatsapp/media/${fname}`;

  const lead  = await Lead.findOne({ phone: { $regex: last10 } }).lean();
  const saved = await WhatsAppMessage.create({
    lead:            lead?._id ?? null,
    phone:           nPhone,
    direction:       "outbound",
    body:            caption || fileName || mediaType,
    messageId:       "",
    agentId:         agentId ?? null,
    connectedUserId: userId,
    read:            true,
    mediaUrl,
    mediaType,
    mimeType,
    fileName,
  });

  emitToUser(userId, "whatsapp:message", {
    leadId:    lead?._id?.toString() ?? null,
    leadName:  lead?.name ?? null,
    phone:     nPhone,
    body:      caption || fileName || mediaType,
    direction: "outbound",
    messageId: saved._id.toString(),
    timestamp: saved.createdAt,
    mediaUrl,
    mediaType,
    mimeType,
    fileName,
  });
}

export function getStatus(userId: string): WAStatusPayload {
  const s = getSession(userId);
  return { status: s.status, phone: s.phone, qrImage: s.qrImage };
}

/** Called once on server start — reconnects all users with saved sessions */
export async function initWhatsApp(): Promise<void> {
  const base = path.resolve("whatsapp-sessions");

  if (!fs.existsSync(base)) {
    console.log("📱 WhatsApp ready — no saved sessions yet");
    return;
  }

  const entries = fs.readdirSync(base, { withFileTypes: true });
  const userDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const userId of userDirs) {
    const credsPath = path.join(base, userId, "creds.json");
    if (fs.existsSync(credsPath)) {
      console.log(`📱 WhatsApp restoring session for user ${userId}…`);
      connect(userId).catch((err) => console.error(`WA restore error (${userId}):`, err));
    }
  }
}
