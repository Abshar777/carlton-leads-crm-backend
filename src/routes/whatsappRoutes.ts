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
router.post("/connect",      checkPermission("whatsapp", "edit"), connectWhatsApp);
router.post("/disconnect",   checkPermission("whatsapp", "edit"), disconnectWhatsApp);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get("/settings",  checkPermission("whatsapp", "view"), getWASettings);
router.put("/settings",  checkPermission("whatsapp", "edit"), updateWASettings);

// ── Portal: chat list & messages ──────────────────────────────────────────────
router.get(  "/chats",                      checkPermission("whatsapp", "view"), getWAChats);
router.get(  "/chats/:phone/messages",      checkPermission("whatsapp", "view"), getPortalMessages);
router.patch("/chats/:phone/read",          checkPermission("whatsapp", "view"), markChatRead);
router.post( "/chats/:phone/assign",        checkPermission("whatsapp", "edit"), assignLeadToChat);
router.post( "/chats/:phone/create-lead",   checkPermission("whatsapp", "edit"), createLeadFromChat);
router.post( "/chats/:phone/send-media",    checkPermission("whatsapp", "edit"), upload.single("file"), sendMediaMessage);

// ── Legacy: per-lead messages (used by lead detail panel) ─────────────────────
router.post(  "/send",                    checkPermission("whatsapp", "edit"), sendWhatsAppMessage);
router.get(   "/messages/:phone",         checkPermission("whatsapp", "view"), getWhatsAppMessages);
router.patch( "/messages/:phone/read",    checkPermission("whatsapp", "view"), markWhatsAppRead);

export default router;
