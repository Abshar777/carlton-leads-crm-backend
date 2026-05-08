import { Router } from "express";
import multer from "multer";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  getWhatsAppMessages,
  markWhatsAppRead,
  getUnreadCount,
  getWAChats,
  getPortalMessages,
  markChatRead,
  assignLeadToChat,
  createLeadFromChat,
  getWASettings,
  updateWASettings,
  sendMediaMessage,
} from "../controllers/whatsappController.js";

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

router.use(authenticate);

// ── Status & connection ───────────────────────────────────────────────────────
router.get( "/status",       getWhatsAppStatus);
router.get( "/unread-count", getUnreadCount);
router.post("/connect",      checkPermission("settings", "edit"), connectWhatsApp);
router.post("/disconnect",   checkPermission("settings", "edit"), disconnectWhatsApp);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get("/settings",  getWASettings);
router.put("/settings",  updateWASettings);

// ── Portal: chat list & messages ──────────────────────────────────────────────
router.get(  "/chats",                      checkPermission("leads", "view"), getWAChats);
router.get(  "/chats/:phone/messages",      checkPermission("leads", "view"), getPortalMessages);
router.patch("/chats/:phone/read",          checkPermission("leads", "view"), markChatRead);
router.post( "/chats/:phone/assign",        checkPermission("leads", "edit"), assignLeadToChat);
router.post( "/chats/:phone/create-lead",   checkPermission("leads", "edit"), createLeadFromChat);
router.post( "/chats/:phone/send-media",    checkPermission("leads", "edit"), upload.single("file"), sendMediaMessage);

// ── Legacy: per-lead messages (used by lead detail panel) ─────────────────────
router.post(  "/send",                    checkPermission("leads", "edit"), sendWhatsAppMessage);
router.get(   "/messages/:phone",         checkPermission("leads", "view"), getWhatsAppMessages);
router.patch( "/messages/:phone/read",    checkPermission("leads", "view"), markWhatsAppRead);

export default router;
