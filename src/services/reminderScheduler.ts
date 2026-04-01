/**
 * Reminder Scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every 30 seconds after the server starts.
 *
 * Two passes per tick:
 *   1. ON-TIME  — reminders whose remindAt ≤ now  (notifiedAt not yet set)
 *      → sends push + socket event "reminder:due"
 *      → stamps notifiedAt so it never fires again
 *
 *   2. WARNING  — reminders whose remindAt is 1 – 31 minutes in the future
 *      (warnedAt not yet set)
 *      → sends push + socket event "reminder:warning"
 *      → stamps warnedAt so the warning never fires again
 *
 * No external cron library needed — plain setInterval is sufficient.
 */

import { Lead } from "../models/Lead.js";
import { sendPushToUser } from "./pushService.js";
import { emitToUser } from "../socket.js";

const INTERVAL_MS      = 30_000;          // run every 30 seconds
const WARN_WINDOW_MS   = 31 * 60_000;     // look ahead 31 min for warnings
const WARN_MIN_MS      = 60_000;          // at least 1 min away (not "now")

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeUserId(createdBy: unknown): string | null {
  if (!createdBy) return null;
  if (typeof createdBy === "string") return createdBy;
  const obj = createdBy as { _id?: { toString(): string }; toString?(): string };
  if (obj._id) return obj._id.toString();
  if (typeof obj.toString === "function") return obj.toString();
  return null;
}

// ─── main tick ───────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const now     = new Date();
  const warnEnd = new Date(now.getTime() + WARN_WINDOW_MS);
  const warnStart = new Date(now.getTime() + WARN_MIN_MS);

  try {
    // ── Pass 1: on-time notifications ──────────────────────────────────────
    const dueLeads = await Lead.find({
      reminders: {
        $elemMatch: {
          isDone:      false,
          notifiedAt:  null,
          remindAt:    { $lte: now },
        },
      },
    }).select("_id name reminders").lean();

    for (const lead of dueLeads) {
      for (const reminder of lead.reminders ?? []) {
        const r = reminder as typeof reminder & {
          notifiedAt?: Date | null;
          warnedAt?:   Date | null;
        };

        if (r.isDone)        continue;
        if (r.notifiedAt)    continue;
        if (r.remindAt > now) continue;

        const userId = safeUserId(r.createdBy);
        if (!userId) continue;

        const title = r.title ?? "Reminder Due";
        const leadName = (lead as unknown as { name?: string }).name ?? "";
        const body  = leadName ? `${title} — ${leadName}` : title;

        // Socket (instant, works while app is open)
        emitToUser(userId, "reminder:due", {
          reminderId: r._id.toString(),
          leadId:     lead._id.toString(),
          leadName,
          title,
          body,
          remindAt:   r.remindAt,
        });

        // Web Push (works even when app/browser is closed)
        sendPushToUser(userId, {
          title: `⏰ ${title}`,
          body,
          tag:   `reminder-due-${r._id.toString()}`,
          url:   `/leads/${lead._id.toString()}`,
          data:  { type: "reminder_due", leadId: lead._id.toString(), reminderId: r._id.toString() },
        }).catch(() => null); // fire-and-forget, don't block

        // Stamp notifiedAt so this reminder never fires again
        await Lead.updateOne(
          { _id: lead._id },
          { $set: { "reminders.$[r].notifiedAt": now } },
          { arrayFilters: [{ "r._id": r._id }] },
        );

        console.log(`🔔 [ReminderScheduler] ON-TIME  user=${userId} reminder="${title}"`);
      }
    }

    // ── Pass 2: 30-min advance warnings ────────────────────────────────────
    const warnLeads = await Lead.find({
      reminders: {
        $elemMatch: {
          isDone:    false,
          warnedAt:  null,
          remindAt:  { $gt: warnStart, $lte: warnEnd },
        },
      },
    }).select("_id name reminders").lean();

    for (const lead of warnLeads) {
      for (const reminder of lead.reminders ?? []) {
        const r = reminder as typeof reminder & {
          notifiedAt?: Date | null;
          warnedAt?:   Date | null;
        };

        if (r.isDone)     continue;
        if (r.warnedAt)   continue;
        if (r.remindAt <= warnStart || r.remindAt > warnEnd) continue;

        const userId = safeUserId(r.createdBy);
        if (!userId) continue;

        const title    = r.title ?? "Upcoming Reminder";
        const leadName = (lead as unknown as { name?: string }).name ?? "";
        const minsLeft = Math.ceil((r.remindAt.getTime() - now.getTime()) / 60_000);
        const body     = leadName
          ? `${title} — ${leadName} (in ${minsLeft} min)`
          : `${title} (in ${minsLeft} min)`;

        // Socket
        emitToUser(userId, "reminder:warning", {
          reminderId: r._id.toString(),
          leadId:     lead._id.toString(),
          leadName,
          title,
          body,
          minsLeft,
          remindAt:   r.remindAt,
        });

        // Web Push
        sendPushToUser(userId, {
          title: `🔔 ${title} in ${minsLeft} min`,
          body,
          tag:   `reminder-warn-${r._id.toString()}`,
          url:   `/leads/${lead._id.toString()}`,
          data:  { type: "reminder_warning", leadId: lead._id.toString(), reminderId: r._id.toString() },
        }).catch(() => null);

        // Stamp warnedAt
        await Lead.updateOne(
          { _id: lead._id },
          { $set: { "reminders.$[r].warnedAt": now } },
          { arrayFilters: [{ "r._id": r._id }] },
        );

        console.log(`🔔 [ReminderScheduler] WARNING   user=${userId} reminder="${title}" minsLeft=${minsLeft}`);
      }
    }
  } catch (err) {
    console.error("[ReminderScheduler] tick error:", err);
  }
}

// ─── export ───────────────────────────────────────────────────────────────────

export function startReminderScheduler(): void {
  console.log(`⏰ ReminderScheduler started (interval: ${INTERVAL_MS / 1000}s)`);
  // Run once immediately on startup to catch any missed reminders
  tick();
  setInterval(tick, INTERVAL_MS);
}
