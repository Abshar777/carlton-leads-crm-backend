import type { Request, Response } from "express";
import * as XLSX from "xlsx";
import { z } from "zod";
import { logTrapEvent, getTrapEvents, getUnreadTrapCount } from "../services/trapService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import type { TrapAction } from "../models/TrapEvent.js";

const logSchema = z.object({
  action:      z.enum(["download_leads", "copy_phone", "print_attempt", "whatsapp_share"]),
  leadId:      z.string().optional(),
  leadName:    z.string().optional(),
  phoneNumber: z.string().optional(),
  page:        z.string().optional(),
});

// POST /api/v1/traps/log
export async function logTrap(req: Request, res: Response) {
  const parsed = logSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid trap payload", 400);

  const userId    = (req as any).user?.userId as string;
  const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";
  const userAgent = req.headers["user-agent"] ?? "";

  const event = await logTrapEvent({
    userId,
    ipAddress,
    userAgent,
    ...parsed.data,
  });

  return sendSuccess(res, "Trap event logged", event);
}

// GET /api/v1/traps/fake-download  — returns blank XLSX, logs the attempt silently
export async function fakeDownload(req: Request, res: Response) {
  const userId    = (req as any).user?.userId as string;
  const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";
  const userAgent = req.headers["user-agent"] ?? "";

  // Log silently — don't wait
  logTrapEvent({ userId, action: "download_leads", ipAddress, userAgent }).catch(() => {});

  // Return a blank workbook
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["Name", "Contact", "Email", "Status", "Team", "Source"]]);
  XLSX.utils.book_append_sheet(wb, ws, "Leads");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", 'attachment; filename="leads_export.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Length", buf.length);
  return res.send(buf);
}

// GET /api/v1/traps  — Super Admin only
export async function listTrapEvents(req: Request, res: Response) {
  const { action, userId, dateFrom, dateTo, page, limit } = req.query;

  const result = await getTrapEvents({
    action:   action as TrapAction | undefined,
    userId:   userId as string | undefined,
    dateFrom: dateFrom as string | undefined,
    dateTo:   dateTo   as string | undefined,
    page:     page  ? parseInt(page  as string) : 1,
    limit:    limit ? parseInt(limit as string) : 50,
  });

  return sendSuccess(res, "Trap events fetched", result);
}

// GET /api/v1/traps/unread-count
export async function unreadCount(req: Request, res: Response) {
  const count = await getUnreadTrapCount();
  return sendSuccess(res, "Unread count", { count });
}
