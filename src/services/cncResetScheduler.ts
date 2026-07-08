/**
 * CNC Reset Scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs once every day at midnight IST (18:30 UTC).
 *
 * Finds all leads with status "cnc" where cncAt is before the start of today
 * (IST), resets them to "assigned", and emits a socket event to each lead's
 * assignedTo user so they see the lead resurface in their queue.
 *
 * Leads without an assignedTo are skipped (nothing to notify).
 * Uses setInterval + time-to-midnight calculation — no external cron library.
 */

import { Lead } from "../models/Lead.js";
import { emitToUser } from "../socket.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

function msUntilMidnightIST(): number {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);

  // Next midnight in IST
  const nextMidnightIST = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1)
  );
  return nextMidnightIST.getTime() - now.getTime();
}

async function runCncReset(): Promise<void> {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);

  // Start of today in IST (converted back to UTC for DB comparison)
  const todayISTMidnight = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - IST_OFFSET_MS
  );

  // Find all CNC leads marked before today
  const leads = await Lead.find({
    status: "cnc",
    cncAt: { $lt: todayISTMidnight },
    assignedTo: { $ne: null },
  })
    .select("_id name assignedTo")
    .lean();

  if (leads.length === 0) return;

  // Bulk reset to assigned
  const ids = leads.map((l) => l._id);
  await Lead.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "assigned", cncAt: null } }
  );

  console.log(`[CNC Reset] ✅ Reset ${leads.length} CNC leads to assigned at midnight IST`);

  // Notify each affected user via socket
  const seen = new Set<string>();
  for (const lead of leads) {
    const userId = lead.assignedTo?.toString();
    if (!userId) continue;

    emitToUser(userId, "lead:cnc-reset", {
      leadId: String(lead._id),
      leadName: lead.name,
      message: `Lead "${lead.name}" has been re-queued for follow-up today`,
    });

    if (!seen.has(userId)) {
      seen.add(userId);
      // One summary notification per user with total count
      const userLeadCount = leads.filter((l) => l.assignedTo?.toString() === userId).length;
      emitToUser(userId, "queue:refreshed", {
        count: userLeadCount,
        message: `${userLeadCount} CNC lead${userLeadCount > 1 ? "s" : ""} re-queued in your daily queue`,
      });
    }
  }
}

export function startCncResetScheduler(): void {
  const delay = msUntilMidnightIST();
  const hours = Math.floor(delay / 3_600_000);
  const mins = Math.floor((delay % 3_600_000) / 60_000);
  console.log(`[CNC Reset] Scheduler armed — first run in ${hours}h ${mins}m (midnight IST)`);

  // Fire at next midnight IST, then every 24h after that
  setTimeout(() => {
    runCncReset().catch((err) => console.error("[CNC Reset] Error:", err));
    setInterval(() => {
      runCncReset().catch((err) => console.error("[CNC Reset] Error:", err));
    }, 24 * 60 * 60 * 1000);
  }, delay);
}
