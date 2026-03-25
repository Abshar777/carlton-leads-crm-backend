import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { sendSuccess, sendError } from "../utils/response.js";

// ─── Validation Schema ────────────────────────────────────────────────────────
// Mirrors exactly the 17 columns in the Google Sheet export from Facebook Lead Ads

const sheetRowSchema = z.object({
  id:            z.string().optional(),           // Facebook lead ID  (e.g. l:1587516...)
  created_time:  z.string().optional(),           // ISO timestamp from Facebook
  ad_id:         z.string().optional(),
  ad_name:       z.string().optional(),
  adset_id:      z.string().optional(),
  adset_name:    z.string().optional(),
  campaign_id:   z.string().optional(),
  campaign_name: z.string().optional(),
  form_id:       z.string().optional(),
  form_name:     z.string().optional(),
  is_organic:    z.union([z.string(), z.boolean()]).optional(),
  platform:      z.string().optional(),           // "ig", "fb", etc.
  full_name:     z.string().min(1, "full_name is required"),
  phone_number:  z.string().min(1, "phone_number is required"),
  email:         z.string().optional(),
  city:          z.string().optional(),
  lead_status:   z.string().optional(),           // Facebook's own status (CREATED etc.)
});

type SheetRow = z.infer<typeof sheetRowSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip the "p:" prefix Facebook sometimes adds to phone numbers */
function cleanPhone(raw: string): string {
  return raw.replace(/^p:/i, "").trim();
}

/** Map Facebook platform shortcodes to CRM source values */
function mapPlatformToSource(platform?: string): string {
  if (!platform) return "other";
  const p = platform.toLowerCase();
  if (p === "ig" || p === "instagram") return "social";
  if (p === "fb" || p === "facebook")  return "social";
  if (p === "wa" || p === "whatsapp")  return "other";
  return "other";
}

/** Build the structured note content from extra sheet columns */
function buildNote(row: SheetRow): string {
  const lines: string[] = [
    "📊 Facebook Ads Lead Import",
    "─────────────────────────────",
  ];

  if (row.city)         lines.push(`📍 City: ${row.city}`);
  if (row.platform)     lines.push(`📱 Platform: ${row.platform.toUpperCase()}`);
  if (row.is_organic !== undefined)
                        lines.push(`🌱 Organic: ${String(row.is_organic)}`);
  if (row.lead_status)  lines.push(`🔖 FB Status: ${row.lead_status}`);
  if (row.created_time) lines.push(`⏰ FB Created: ${row.created_time}`);
  if (row.id)           lines.push(`🆔 FB Lead ID: ${row.id}`);

  lines.push("");
  lines.push("📢 Campaign Details");
  lines.push("─────────────────────────────");
  if (row.campaign_name) lines.push(`Campaign : ${row.campaign_name}${row.campaign_id ? ` (${row.campaign_id})` : ""}`);
  if (row.adset_name)    lines.push(`Ad Set   : ${row.adset_name}${row.adset_id ? ` (${row.adset_id})` : ""}`);
  if (row.ad_name)       lines.push(`Ad       : ${row.ad_name}${row.ad_id ? ` (${row.ad_id})` : ""}`);
  if (row.form_name)     lines.push(`Form     : ${row.form_name}${row.form_id ? ` (${row.form_id})` : ""}`);

  return lines.join("\n");
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * POST /api/sheets/sync
 *
 * Accepts a single row from the Google Sheet (one object per call).
 * - Maps core fields → Lead document
 * - Stores extra metadata as a Note on the lead
 * - Skips silently if a lead with the same phone already exists (returns existing lead ID)
 * - The Super Admin user is used as the system reporter
 */
export const syncSheetLead = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = sheetRowSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const row = parsed.data;
    const phone = cleanPhone(row.phone_number);
    const email = row.email?.trim() || undefined;

    // ── Duplicate check on phone ───────────────────────────────────────────
    const existing = await Lead.findOne({ phone });
    if (existing) {
      sendSuccess(res, "Lead already exists — skipped", {
        leadId: existing._id.toString(),
        duplicate: true,
        phone,
      });
      return;
    }

    // ── Find Super Admin as system reporter ────────────────────────────────
    const superAdmin = await User.findOne({ email: process.env.SUPER_ADMIN_EMAIL });
    if (!superAdmin) {
      sendError(res, "System reporter (Super Admin) not found. Check SUPER_ADMIN_EMAIL in .env.", 500);
      return;
    }
    const reporterId = superAdmin._id.toString();

    // ── Build note from extra fields ───────────────────────────────────────
    const noteContent = buildNote(row);

    // ── Create lead ────────────────────────────────────────────────────────
    const lead = await Lead.create({
      name:     row.full_name.trim(),
      phone,
      email,
      source:   mapPlatformToSource(row.platform),
      status:   "new",
      reporter: reporterId,
      notes: [
        {
          content:   noteContent,
          author:    reporterId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      activityLogs: [
        {
          action:      "lead_created",
          description: "Lead imported from Google Sheets (Facebook Ads)",
          performedBy: reporterId,
          createdAt:   new Date(),
        },
      ],
    });

    sendSuccess(
      res,
      "Lead created successfully",
      {
        leadId:    lead._id.toString(),
        duplicate: false,
        name:      lead.name,
        phone:     lead.phone,
      },
      201,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/sheets/sync/batch
 *
 * Accepts an array of rows (bulk import from App Script).
 * Processes each row independently — duplicates are skipped, not errored.
 */
export const syncSheetLeadsBatch = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      sendError(res, "\"rows\" must be a non-empty array", 400);
      return;
    }

    if (rows.length > 200) {
      sendError(res, "Batch limit is 200 rows per request", 400);
      return;
    }

    const superAdmin = await User.findOne({ email: process.env.SUPER_ADMIN_EMAIL });
    if (!superAdmin) {
      sendError(res, "System reporter (Super Admin) not found", 500);
      return;
    }
    const reporterId = superAdmin._id.toString();

    const results: Array<{
      index:     number;
      status:    "created" | "duplicate" | "invalid";
      leadId?:   string;
      phone?:    string;
      reason?:   string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const parsed = sheetRowSchema.safeParse(rows[i]);

      if (!parsed.success) {
        results.push({
          index:  i,
          status: "invalid",
          reason: JSON.stringify(parsed.error.flatten().fieldErrors),
        });
        continue;
      }

      const row   = parsed.data;
      const phone = cleanPhone(row.phone_number);
      const email = row.email?.trim() || undefined;

      // Check duplicate
      const exists = await Lead.findOne({ phone });
      if (exists) {
        results.push({ index: i, status: "duplicate", leadId: exists._id.toString(), phone });
        continue;
      }

      const noteContent = buildNote(row);

      const lead = await Lead.create({
        name:     row.full_name.trim(),
        phone,
        email,
        source:   mapPlatformToSource(row.platform),
        status:   "new",
        reporter: reporterId,
        notes: [
          {
            content:   noteContent,
            author:    reporterId,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        activityLogs: [
          {
            action:      "lead_created",
            description: "Lead imported from Google Sheets (Facebook Ads)",
            performedBy: reporterId,
            createdAt:   new Date(),
          },
        ],
      });

      results.push({ index: i, status: "created", leadId: lead._id.toString(), phone });
    }

    const created   = results.filter((r) => r.status === "created").length;
    const duplicate = results.filter((r) => r.status === "duplicate").length;
    const invalid   = results.filter((r) => r.status === "invalid").length;

    sendSuccess(res, `Batch processed: ${created} created, ${duplicate} skipped (duplicate), ${invalid} invalid`, {
      summary: { total: rows.length, created, duplicate, invalid },
      results,
    }, 201);
  } catch (err) {
    next(err);
  }
};
