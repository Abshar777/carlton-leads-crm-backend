import mongoose from "mongoose";
import path from "path";
import fs from "fs";
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { WhatsAppMessage }  from "../models/WhatsAppMessage.js";
import { WhatsAppSettings } from "../models/WhatsAppSettings.js";
import { Lead }             from "../models/Lead.js";
import {
  connect,
  disconnectWA,
  sendMessage,
  sendMedia,
  getStatus,
} from "../services/whatsappService.js";

const MEDIA_DIR = path.resolve("uploads/whatsapp-media");

// ── Status & connection ───────────────────────────────────────────────────────

/** GET /whatsapp/status */
export const getWhatsAppStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    sendSuccess(res, "OK", getStatus(req.user!.userId));
  } catch (err) { next(err); }
};

/** POST /whatsapp/connect */
export const connectWhatsApp = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    connect(req.user!.userId).catch((err) => console.error("WhatsApp connect error:", err));
    sendSuccess(res, "Connecting — scan the QR code");
  } catch (err) { next(err); }
};

/** POST /whatsapp/disconnect */
export const disconnectWhatsApp = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await disconnectWA(req.user!.userId);
    sendSuccess(res, "WhatsApp disconnected");
  } catch (err) { next(err); }
};

// ── Messaging ─────────────────────────────────────────────────────────────────

/** POST /whatsapp/send  body: { phone, message } */
export const sendWhatsAppMessage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { phone, message } = req.body as { phone?: string; message?: string };
    if (!phone?.trim() || !message?.trim()) {
      sendError(res, "phone and message are required", 400);
      return;
    }
    await sendMessage(req.user!.userId, phone.trim(), message.trim(), req.user!.userId);
    sendSuccess(res, "Message sent");
  } catch (err) {
    if ((err as Error).message === "WhatsApp not connected") {
      sendError(res, "WhatsApp not connected", 503);
      return;
    }
    next(err);
  }
};

// ── Portal: chat list ─────────────────────────────────────────────────────────

/**
 * GET /whatsapp/chats
 * Returns one entry per unique phone number for this user's WA session,
 * sorted by last message time desc.
 */
export const getWAChats = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);

    const chats = await WhatsAppMessage.aggregate([
      {
        $match: {
          $or: [
            { connectedUserId: userId },
            { connectedUserId: null },
            { connectedUserId: { $exists: false } },
          ],
        },
      },
      { $sort:  { createdAt: -1 } },
      {
        $group: {
          _id:        "$phone",
          lastBody:   { $first: "$body" },
          lastAt:     { $first: "$createdAt" },
          lastDir:    { $first: "$direction" },
          senderName: { $first: "$senderName" },
          leadId:     { $first: "$lead" },
          unread:     {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$direction", "inbound"] }, { $eq: ["$read", false] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { lastAt: -1 } },
    ]);

    // Enrich with lead name if linked
    const leadIds = chats.map((c) => c.leadId).filter(Boolean);
    const leads   = await Lead.find({ _id: { $in: leadIds } }, "name phone").lean();
    const leadMap = new Map(leads.map((l) => [l._id.toString(), l]));

    const result = chats.map((c) => ({
      phone:      c._id as string,
      senderName: c.senderName as string,
      lastBody:   c.lastBody  as string,
      lastAt:     c.lastAt    as Date,
      lastDir:    c.lastDir   as string,
      unread:     c.unread    as number,
      lead:       c.leadId ? (leadMap.get(c.leadId.toString()) ?? null) : null,
    }));

    sendSuccess(res, "OK", result);
  } catch (err) { next(err); }
};

// ── Portal: messages for a phone ─────────────────────────────────────────────

/**
 * GET /whatsapp/chats/:phone/messages?limit=50&before=<date>
 */
export const getPortalMessages = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId  = new mongoose.Types.ObjectId(req.user!.userId);
    const phone   = req.params.phone.replace(/\D/g, "");
    const last10  = phone.slice(-10);
    const limit   = Math.min(Number(req.query.limit) || 50, 200);
    const before  = req.query.before ? new Date(req.query.before as string) : undefined;

    const filter: Record<string, unknown> = {
      $or: [
        { connectedUserId: userId },
        { connectedUserId: null },
        { connectedUserId: { $exists: false } },
      ],
      phone: { $regex: last10 },
    };
    if (before) filter.createdAt = { $lt: before };

    const msgs = await WhatsAppMessage
      .find(filter)
      .populate("agentId", "name")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    sendSuccess(res, "OK", msgs.reverse());
  } catch (err) { next(err); }
};

// ── Portal: mark read ─────────────────────────────────────────────────────────

/** PATCH /whatsapp/chats/:phone/read */
export const markChatRead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const phone  = req.params.phone.replace(/\D/g, "");
    const last10 = phone.slice(-10);

    await WhatsAppMessage.updateMany(
      {
        $or: [{ connectedUserId: userId }, { connectedUserId: null }, { connectedUserId: { $exists: false } }],
        phone: { $regex: last10 }, direction: "inbound", read: false,
      },
      { $set: { read: true } },
    );
    sendSuccess(res, "Marked as read");
  } catch (err) { next(err); }
};

// ── Portal: assign lead ───────────────────────────────────────────────────────

/**
 * POST /whatsapp/chats/:phone/assign
 * body: { leadId }
 */
export const assignLeadToChat = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const phone  = req.params.phone.replace(/\D/g, "");
    const last10 = phone.slice(-10);
    const { leadId } = req.body as { leadId?: string };

    if (!leadId || !mongoose.isValidObjectId(leadId)) {
      sendError(res, "Valid leadId is required", 400);
      return;
    }

    const lead = await Lead.findById(leadId).lean();
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    await WhatsAppMessage.updateMany(
      {
        $or: [{ connectedUserId: userId }, { connectedUserId: null }, { connectedUserId: { $exists: false } }],
        phone: { $regex: last10 },
      },
      { $set: { lead: new mongoose.Types.ObjectId(leadId) } },
    );

    sendSuccess(res, "Lead assigned", { lead });
  } catch (err) { next(err); }
};

// ── Portal: create lead from chat ─────────────────────────────────────────────

/**
 * POST /whatsapp/chats/:phone/create-lead
 * body: { name? }
 */
export const createLeadFromChat = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId     = new mongoose.Types.ObjectId(req.user!.userId);
    const phone      = req.params.phone.replace(/\D/g, "");
    const last10     = phone.slice(-10);
    const { name }   = req.body as { name?: string };

    const legacyFilter = {
      $or: [{ connectedUserId: userId }, { connectedUserId: null }, { connectedUserId: { $exists: false } }],
      phone: { $regex: last10 },
    };

    let displayName = name?.trim();
    if (!displayName) {
      const latest = await WhatsAppMessage.findOne(legacyFilter).sort({ createdAt: -1 }).lean();
      displayName = latest?.senderName || phone;
    }

    const lead = await Lead.create({
      name:   displayName,
      phone,
      source: "WhatsApp",
      status: "new",
    });

    await WhatsAppMessage.updateMany(legacyFilter, { $set: { lead: lead._id } });

    sendSuccess(res, "Lead created", { lead }, 201);
  } catch (err) { next(err); }
};

// ── Settings ──────────────────────────────────────────────────────────────────

/** GET /whatsapp/settings */
export const getWASettings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const settings = await WhatsAppSettings.findOneAndUpdate(
      { userId: req.user!.userId },
      { $setOnInsert: { userId: req.user!.userId, autoCreateLeads: false } },
      { upsert: true, new: true, lean: true },
    );
    sendSuccess(res, "OK", settings);
  } catch (err) { next(err); }
};

/** PUT /whatsapp/settings  body: { autoCreateLeads } */
export const updateWASettings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { autoCreateLeads } = req.body as { autoCreateLeads?: boolean };
    if (typeof autoCreateLeads !== "boolean") {
      sendError(res, "autoCreateLeads must be a boolean", 400);
      return;
    }

    const settings = await WhatsAppSettings.findOneAndUpdate(
      { userId: req.user!.userId },
      { $set: { autoCreateLeads } },
      { upsert: true, new: true, lean: true },
    );
    sendSuccess(res, "Settings updated", settings);
  } catch (err) { next(err); }
};

// ── Legacy: per-lead messages (lead detail page) ──────────────────────────────

/** GET /whatsapp/messages/:phone */
export const getWhatsAppMessages = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const phone  = req.params.phone.replace(/\D/g, "");
    const last10 = phone.slice(-10);

    const msgs = await WhatsAppMessage
      .find({
        $or: [{ connectedUserId: userId }, { connectedUserId: null }, { connectedUserId: { $exists: false } }],
        phone: { $regex: last10 },
      })
      .populate("agentId", "name")
      .sort({ createdAt: 1 })
      .lean();

    sendSuccess(res, "OK", msgs);
  } catch (err) { next(err); }
};

/** GET /whatsapp/unread-count */
export const getUnreadCount = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const count  = await WhatsAppMessage.countDocuments({
      connectedUserId: userId,
      direction:       "inbound",
      read:            false,
    });
    sendSuccess(res, "OK", { count });
  } catch (err) { next(err); }
};

/** PATCH /whatsapp/messages/:phone/read */
export const markWhatsAppRead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user!.userId);
    const phone  = req.params.phone.replace(/\D/g, "");
    const last10 = phone.slice(-10);
    await WhatsAppMessage.updateMany(
      { connectedUserId: userId, phone: { $regex: last10 }, direction: "inbound", read: false },
      { $set: { read: true } },
    );
    sendSuccess(res, "Marked as read");
  } catch (err) { next(err); }
};

// ── Media ─────────────────────────────────────────────────────────────────────

/**
 * POST /whatsapp/chats/:phone/send-media
 * multipart/form-data: file (required), caption? (text)
 */
export const sendMediaMessage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    if (!file) { sendError(res, "No file uploaded", 400); return; }

    const phone   = req.params.phone.replace(/\D/g, "");
    const caption = (req.body as { caption?: string }).caption?.trim() ?? "";

    await sendMedia(
      req.user!.userId,
      phone,
      file.buffer,
      file.mimetype,
      file.originalname,
      caption,
      req.user!.userId,
    );
    sendSuccess(res, "Media sent");
  } catch (err) {
    if ((err as Error).message === "WhatsApp not connected") {
      sendError(res, "WhatsApp not connected", 503); return;
    }
    next(err);
  }
};

/**
 * GET /whatsapp/media/:filename
 * Serves uploaded/downloaded media files.
 */
export const serveMediaFile = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  try {
    const { filename } = req.params;
    // Basic path traversal guard
    if (filename.includes("..") || filename.includes("/")) {
      sendError(res, "Invalid filename", 400); return;
    }
    const filePath = path.join(MEDIA_DIR, filename);
    if (!fs.existsSync(filePath)) { sendError(res, "File not found", 404); return; }
    res.sendFile(filePath);
  } catch (err) { next(err); }
};
