import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { LeadService, resolveNewLeadTeam } from "../services/leadService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const leadService = new LeadService();

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

  // ── "WITH QA" sheet only ───────────────────────────────────────────────────
  // Lead-form questions. Absent on the Meta and WhatsApp sheets, which is what
  // keeps those rows producing exactly one note as before.
  when_will_you_like_to_join:         z.string().optional(),
  do_you_have_any_trading_experience: z.string().optional(),
});

type SheetRow = z.infer<typeof sheetRowSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip the "p:" prefix Facebook sometimes adds to phone numbers */
function cleanPhone(raw: string): string {
  return raw.replace(/^p:/i, "").trim();
}

/**
 * The email, but only if it really is one.
 *
 * The sheets carry placeholders rather than blanks — the WhatsApp sheet writes
 * the literal "No Email" in every row. The Lead model validates this field with
 * /^\S+@\S+\.\S+$/, so passing a placeholder through makes Mongoose throw and
 * the whole row fails with a bare "Validation failed". A value that cannot be
 * an address is dropped instead, which costs nothing: it was never usable.
 */
function cleanEmail(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return /^\S+@\S+\.\S+$/.test(trimmed) ? trimmed : undefined;
}

/** Map platform shortcodes to CRM source values */
function mapPlatformToSource(platform?: string): string {
  if (!platform) return "other";
  const p = platform.toLowerCase();
  if (p === "ig" || p === "instagram") return "instagram";
  if (p === "fb" || p === "facebook")  return "facebook";
  if (p === "wa" || p === "whatsapp")  return "whatsapp";
  if (p === "google" || p === "gads" || p === "google ads") return "google";
  return "other";
}

/**
 * Facebook sends answers as raw option ids — "would_like_to_know_more". Turn
 * them into something a caller can read at a glance, while leaving answers that
 * are already plain text ("Not much", "Fees") untouched.
 */
function humaniseAnswer(raw: string): string {
  const spaced = raw.trim().replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Second note, from the lead-form questions on the "WITH QA" sheet.
 *
 * Returns null when the row carries neither answer, so Meta and WhatsApp rows
 * keep getting a single note and no empty note is ever attached.
 */
function buildQaNote(row: SheetRow): string | null {
  const join     = row.when_will_you_like_to_join?.trim();
  const tradeExp = row.do_you_have_any_trading_experience?.trim();
  if (!join && !tradeExp) return null;

  const lines: string[] = [
    "📝 Lead Form Answers",
    "─────────────────────────────",
  ];
  if (join)     lines.push(`🕒 When will you like to join : ${humaniseAnswer(join)}`);
  if (tradeExp) lines.push(`📈 Trading experience        : ${humaniseAnswer(tradeExp)}`);

  return lines.join("\n");
}

/**
 * The notes a freshly imported lead starts with: the import summary always, and
 * the form answers as a *separate* second note when the row carries them.
 */
function buildNotes(row: SheetRow, authorId: unknown) {
  const now = new Date();
  const entries = [buildNote(row), buildQaNote(row)].filter(Boolean) as string[];
  return entries.map((content) => ({
    content,
    author:    authorId,
    createdAt: now,
    updatedAt: now,
  }));
}

/** Build note for Meta/Facebook Ads rows */
function buildNote(row: SheetRow): string {
  const p = (row.platform ?? "").toLowerCase();
  const isWhatsApp = p === "wa" || p === "whatsapp";
  const isGoogle   = p === "google" || p === "gads" || p === "google ads";

  if (isWhatsApp || isGoogle) {
    const label = isWhatsApp ? "WhatsApp" : "Google Ads";
    const lines: string[] = [
      `📲 ${label} Lead Import`,
      "─────────────────────────────",
    ];
    if (row.platform)  lines.push(`📱 Platform: ${row.platform}`);
    if (row.city)      lines.push(`📍 City: ${row.city}`);
    return lines.join("\n");
  }

  // Default: Facebook / Instagram Ads
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
    const email = cleanEmail(row.email);

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

    // ── Build the lead's starting notes ────────────────────────────────────
    const noteDocs = buildNotes(row, reporterId);

    // ── Team routing ───────────────────────────────────────────────────────
    // Same rule every creation path uses: workflow ON -> Dummy Team (entry point).
    // Without this the lead is created teamless and relies on the balancer, which is
    // barred from workflow-reserved teams and would leave it permanently unassigned.
    const workflowTeamId = await resolveNewLeadTeam();

    // ── Create lead ────────────────────────────────────────────────────────
    const lead = await Lead.create({
      name:     row.full_name?.trim()||"no name",
      ...(workflowTeamId ? { team: workflowTeamId } : {}),
      phone,
      email,
      source:   mapPlatformToSource(row.platform),
      platform: row.platform?.trim() || undefined,
      campaign: row.campaign_name?.trim() || undefined,
      status:   "new",
      reporter: reporterId,
      notes: noteDocs,
      activityLogs: [
        {
          action:      "lead_created",
          description: `Lead imported from Google Sheets (${mapPlatformToSource(row.platform) === "whatsapp" ? "WhatsApp" : mapPlatformToSource(row.platform) === "google" ? "Google Ads" : "Facebook Ads"})`,
          performedBy: reporterId,
          createdAt:   new Date(),
        },
      ],
    });

    // ── Auto-assign to least-loaded active team ────────────────────────────
    // Workflow ON: already routed to the Dummy Team above; the workflow drives it from
    // there, so the balancer must not touch it. Workflow OFF: balance as before.
    let assignedTeam: string | null = workflowTeamId;
    if (!workflowTeamId) {
      try {
        const assignment = await leadService.autoAssignLeads([lead._id.toString()]);
        if (assignment.assigned > 0 && assignment.results[0]) {
          assignedTeam = assignment.results[0].assignedTo;
        }
      } catch (err) {
        console.error(`[sheets] Auto-assign failed for lead ${lead._id.toString()} (${phone}):`, err);
      }
    }

    sendSuccess(
      res,
      "Lead created successfully",
      {
        leadId:       lead._id.toString(),
        duplicate:    false,
        name:         lead.name,
        phone:        lead.phone,
        assignedTeam: assignedTeam ?? "unassigned",
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

    // Resolved once for the whole batch — workflow ON -> Dummy Team (entry point)
    const workflowTeamId = await resolveNewLeadTeam();

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
      const email = cleanEmail(row.email);

      // Check duplicate
      const exists = await Lead.findOne({ phone });
      if (exists) {
        results.push({ index: i, status: "duplicate", leadId: exists._id.toString(), phone });
        continue;
      }

      const noteDocs = buildNotes(row, reporterId);

      const lead = await Lead.create({
        name:     row.full_name.trim(),
        phone,
        email,
        ...(workflowTeamId ? { team: workflowTeamId } : {}),
        source:   mapPlatformToSource(row.platform),
        platform: row.platform?.trim() || undefined,
        campaign: row.campaign_name?.trim() || undefined,
        status:   "new",
        reporter: reporterId,
        notes: noteDocs,
        activityLogs: [
          {
            action:      "lead_created",
            description: `Lead imported from Google Sheets (${mapPlatformToSource(row.platform) === "whatsapp" ? "WhatsApp" : mapPlatformToSource(row.platform) === "google" ? "Google Ads" : "Facebook Ads"})`,
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

    // ── Auto-assign all newly created leads to teams in one pass ───────────
    let assigned = 0;
    const createdIds = results
      .filter((r) => r.status === "created" && r.leadId)
      .map((r) => r.leadId as string);

    if (createdIds.length > 0) {
      if (workflowTeamId) {
        // Already routed to the Dummy Team at creation — the workflow takes it from here.
        assigned = createdIds.length;
      } else {
        try {
          const assignment = await leadService.autoAssignLeads(createdIds);
          assigned = assignment.assigned;
        } catch (err) {
          console.error(`[sheets] Batch auto-assign failed for ${createdIds.length} lead(s):`, err);
        }
      }
    }

    sendSuccess(res, `Batch processed: ${created} created, ${duplicate} skipped (duplicate), ${invalid} invalid`, {
      summary: { total: rows.length, created, duplicate, invalid, assignedToTeam: assigned },
      results,
    }, 201);
  } catch (err) {
    next(err);
  }
};
