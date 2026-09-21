import { Types } from "mongoose";
import { CallSession } from "../models/CallSession.js";
import { WorkSchedule, DAY_KEYS } from "../models/WorkSchedule.js";
import { User } from "../models/User.js";
import { Lead } from "../models/Lead.js";
import { emitToUser } from "../socket.js";

/**
 * Which lead to offer next, in order. The queue works a whole tier before it
 * touches the next one: every callable "assigned" lead comes before the first
 * "interested", and so on down the list.
 */
export const CALL_PRIORITY = [
  "assigned", "interested", "callback", "followup", "cnc", "rnr",
] as const;

/** Statuses that make a lead worth calling — the tiers, order removed. */
export const CALLABLE_STATUSES: string[] = [...CALL_PRIORITY];

/** Midnight this morning, IST — the boundary for "offered already today". */
function istDayStart(now = new Date()): Date {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });  // YYYY-MM-DD
  return new Date(`${ymd}T00:00:00.000+05:30`);
}

const mins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes since IST midnight, and the IST weekday key, for "is this user on shift". */
function istNow(now = new Date()) {
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return {
    minutes: ist.getHours() * 60 + ist.getMinutes(),
    day: DAY_KEYS[ist.getDay()],   // getDay() is 0=Sun, matching DAY_KEYS order
  };
}

export interface ShiftState {
  onShift: boolean;
  /** "off" when it is not a working day for them. */
  mode: "off" | "full" | "half";
}

/**
 * Whether a schedule puts someone on shift right now. Overnight shifts are
 * supported: when logout is "before" login the window wraps past midnight.
 */
export function shiftStateFor(
  schedule: { loginTime: string; logoutTime: string; halfDayLogoutTime?: string; workDays: Record<string, string> },
  now = new Date(),
): ShiftState {
  const { minutes, day } = istNow(now);
  const mode = (schedule.workDays?.[day] ?? "off") as ShiftState["mode"];
  if (mode === "off") return { onShift: false, mode };

  const start = mins(schedule.loginTime);
  const end = mins(
    mode === "half" && schedule.halfDayLogoutTime ? schedule.halfDayLogoutTime : schedule.logoutTime,
  );

  const onShift = start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;   // wraps past midnight

  return { onShift, mode };
}

/**
 * The next lead this user should call, or null when their queue is empty.
 *
 * Walks CALL_PRIORITY in order and returns the first match, newest lead first
 * within a tier. Leads already offered today are held back until the rest of
 * the queue has been through, so the newest lead in the top tier cannot be
 * handed out over and over — nothing else moves it down the order, since
 * being called does not modify the lead.
 */
export async function nextLeadFor(userId: string, now = new Date()) {
  const dayStart = istDayStart(now);
  const select = "name phone status";

  // Pass 1 — anything not yet offered today, best tier first, newest first
  for (const status of CALL_PRIORITY) {
    const lead = await Lead.findOne({
      assignedTo: userId,
      status,
      $or: [{ lastCallPromptedAt: null }, { lastCallPromptedAt: { $lt: dayStart } }],
    })
      .sort({ createdAt: -1 })
      .select(select)
      .lean();
    if (lead) return lead;
  }

  // Pass 2 — the whole queue has been offered today, so come back round to
  // whoever was offered longest ago, still respecting the tier order
  for (const status of CALL_PRIORITY) {
    const lead = await Lead.findOne({ assignedTo: userId, status })
      .sort({ lastCallPromptedAt: 1, createdAt: -1 })
      .select(select)
      .lean();
    if (lead) return lead;
  }

  return null;
}

/**
 * Remember that a lead was offered, without counting as an edit.
 *
 * timestamps:false matters — the leads list and several filters sort on
 * updatedAt, and a lead should not jump to the top of them merely because the
 * popup showed it to somebody.
 */
async function markLeadOffered(leadId: unknown, now: Date) {
  await Lead.updateOne({ _id: leadId }, { $set: { lastCallPromptedAt: now } }, { timestamps: false });
}

/** The user's open prompt, if one is waiting on them. */
export function openSessionFor(userId: string) {
  return CallSession.findOne({ user: userId, action: null }).sort({ promptedAt: -1 });
}

/** The call whose details they still owe us, if any. */
export function pendingOutcomeFor(userId: string) {
  return CallSession.findOne({ user: userId, outcomeStatus: "pending" }).sort({ callStartedAt: -1 });
}

/** How long we keep asking whether someone is back before giving up on them. */
export const BREAK_RETURN_WINDOW_MINUTES = 30;

/**
 * A finished break that is still waiting for "I'm back".
 *
 * Only breaks the scheduler has actually asked about count, which is what keeps
 * every historical break row out of this — they were never prompted.
 */
export function awaitingBreakReturnFor(userId: string) {
  return CallSession.findOne({
    user: userId,
    action: "break",
    breakReturnPromptedAt: { $ne: null },
    breakReturnedAt: null,
    breakReturnClosedAt: null,
  }).sort({ breakEndsAt: -1 });
}

/** True when the user is inside an active break. */
export async function onBreak(userId: string): Promise<boolean> {
  const b = await CallSession.findOne({
    user: userId,
    action: "break",
    breakEndsAt: { $gt: new Date() },
  }).select("_id").lean();
  return !!b;
}

/**
 * One scheduler tick. Prompts every scheduled user who is on shift, has no open
 * prompt, is not on a break, and whose last response is older than their
 * schedule's prompt interval.
 */
export async function runCallPromptTick(now = new Date()) {
  const users = await User.find({ status: "active", workSchedule: { $ne: null } })
    .populate("workSchedule")
    .select("_id name workSchedule")
    .lean();

  let prompted = 0;
  let expired = 0;

  for (const u of users) {
    const schedule = u.workSchedule as unknown as {
      loginTime: string; logoutTime: string; halfDayLogoutTime?: string;
      workDays: Record<string, string>; promptIntervalMinutes: number;
    } | null;
    if (!schedule) continue;

    const userId = String(u._id);
    const { onShift } = shiftStateFor(schedule, now);

    // Off shift: close any prompt still hanging so it is not answered tomorrow
    if (!onShift) {
      const stale = await CallSession.find({ user: userId, action: null });
      for (const open of stale) {
        open.action = "expired";
        open.respondedAt = now;
        open.holdSeconds = Math.round((now.getTime() - open.promptedAt.getTime()) / 1000);
        await open.save();
        expired += 1;
      }

      // A pending outcome blocks every future prompt, so it must not survive the
      // shift. Closing it as skipped keeps it visible to an admin rather than
      // quietly dropping a call nobody wrote up.
      const owing = await pendingOutcomeFor(userId);
      if (owing) {
        owing.outcomeStatus = "skipped";
        owing.outcomeSkipReason = "Not filled in before the shift ended";
        owing.outcomeAt = now;
        await owing.save();
        expired += 1;
      }

      const unconfirmed = await awaitingBreakReturnFor(userId);
      if (unconfirmed) {
        unconfirmed.breakReturnClosedAt = now;
        await unconfirmed.save();
        expired += 1;
      }
      continue;
    }

    // Break just ran out and nobody has asked yet — ask now.
    const justEnded = await CallSession.findOne({
      user: userId,
      action: "break",
      breakEndsAt: { $lte: now, $gte: new Date(now.getTime() - BREAK_RETURN_WINDOW_MINUTES * 60_000) },
      breakReturnPromptedAt: null,
      breakReturnedAt: null,
      breakReturnClosedAt: null,
    }).sort({ breakEndsAt: -1 });
    if (justEnded) {
      justEnded.breakReturnPromptedAt = now;
      await justEnded.save();
      emitToUser(userId, "call:break-over", {
        sessionId: String(justEnded._id),
        breakEndsAt: justEnded.breakEndsAt,
      });
    }

    // Asked a while ago and still no answer — stop blocking them, but leave the
    // row unconfirmed so the admin page can show it.
    const ignoring = await awaitingBreakReturnFor(userId);
    if (ignoring?.breakReturnPromptedAt &&
        now.getTime() - ignoring.breakReturnPromptedAt.getTime() >= BREAK_RETURN_WINDOW_MINUTES * 60_000) {
      ignoring.breakReturnClosedAt = now;
      await ignoring.save();
    }

    if (await openSessionFor(userId)) continue;         // already waiting on them
    if (await pendingOutcomeFor(userId)) continue;      // owes details on the last call
    if (await onBreak(userId)) continue;
    if (await awaitingBreakReturnFor(userId)) continue; // has not confirmed they are back

    const interval = schedule.promptIntervalMinutes ?? 2;
    const last = await CallSession.findOne({ user: userId, respondedAt: { $ne: null } })
      .sort({ respondedAt: -1 })
      .select("respondedAt")
      .lean();
    if (last?.respondedAt && now.getTime() - new Date(last.respondedAt).getTime() < interval * 60_000) {
      continue;
    }

    const lead = await nextLeadFor(userId);
    if (!lead) continue;                                // nothing to call

    const session = await CallSession.create({ user: userId, lead: lead._id, promptedAt: now });
    await markLeadOffered(lead._id, now);
    emitToUser(userId, "call:prompt", {
      sessionId: String(session._id),
      promptedAt: session.promptedAt,
      lead: { _id: String(lead._id), name: lead.name, phone: lead.phone, status: lead.status },
    });
    prompted += 1;
  }

  return { prompted, expired, considered: users.length };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

const TICK_MS = 60_000;   // once a minute is enough; prompt intervals are in minutes
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the call-prompt loop. Plain setInterval, matching the reminder and
 * backup schedulers — no cron dependency.
 *
 * Only users with a work schedule are ever considered, so this is inert until
 * schedules are assigned.
 */
export function startCallAutomationScheduler(): void {
  if (timer) return;                     // guard against double-start on reload

  const tick = async () => {
    try {
      const result = await runCallPromptTick();
      if (result.prompted > 0 || result.expired > 0) {
        console.log(`[call-automation] prompted=${result.prompted} expired=${result.expired} of ${result.considered} scheduled user(s)`);
      }
    } catch (err) {
      // Never let a bad tick kill the interval — the next one should still run
      console.error("[call-automation] tick failed:", err);
    }
  };

  timer = setInterval(tick, TICK_MS);
  void tick();
  console.log("📞 Call automation scheduler started (every 60s)");
}

export function stopCallAutomationScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// ─── Admin reporting ──────────────────────────────────────────────────────────

export interface AdminOverviewFilters {
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
}

function istRange(f: AdminOverviewFilters) {
  const range: Record<string, Date> = {};
  if (f.dateFrom) {
    const d = new Date(`${f.dateFrom}T00:00:00.000+05:30`);
    if (!isNaN(d.getTime())) range.$gte = d;
  }
  if (f.dateTo) {
    const d = new Date(`${f.dateTo}T23:59:59.999+05:30`);
    if (!isNaN(d.getTime())) range.$lte = d;
  }
  // Default to today (IST) so the page opens on something useful rather than
  // every session ever recorded.
  if (!range.$gte && !range.$lte) {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    range.$gte = new Date(`${ist.toISOString().slice(0, 10)}T00:00:00.000+05:30`);
  }
  return range;
}

/** Everything the Call Automation page needs, in one round trip. */
export async function adminOverview(filters: AdminOverviewFilters = {}) {
  const match: Record<string, unknown> = { promptedAt: istRange(filters) };
  if (filters.userId && Types.ObjectId.isValid(filters.userId)) {
    // aggregate() does not cast strings to ObjectId the way find() does
    match.user = new Types.ObjectId(filters.userId);
  }

  const [byAction, rejections, longHolds, activeBreaks, perUser, callLog, outcomeCounts, breakLog] = await Promise.all([
    CallSession.aggregate([
      { $match: match },
      { $group: { _id: "$action", n: { $sum: 1 } } },
    ]),

    CallSession.find({ ...match, action: "rejected" })
      .populate("user", "name email")
      .populate("lead", "name phone status")
      .sort({ respondedAt: -1 })
      .limit(200)
      .lean(),

    // "Held too long" is per-schedule, so the threshold is resolved per row on
    // the way out rather than baked into this query.
    CallSession.find({ ...match, holdSeconds: { $ne: null } })
      .populate("user", "name email")
      .populate("lead", "name phone")
      .sort({ holdSeconds: -1 })
      .limit(200)
      .lean(),

    CallSession.find({ action: "break", breakEndsAt: { $gt: new Date() } })
      .populate("user", "name email")
      .sort({ respondedAt: -1 })
      .lean(),

    CallSession.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$user",
          total:     { $sum: 1 },
          called:    { $sum: { $cond: [{ $eq: ["$action", "called"] },   1, 0] } },
          updated:   { $sum: { $cond: [{ $eq: ["$action", "updated"] },  1, 0] } },
          rejected:  { $sum: { $cond: [{ $eq: ["$action", "rejected"] }, 1, 0] } },
          breaks:    { $sum: { $cond: [{ $eq: ["$action", "break"] },    1, 0] } },
          expired:   { $sum: { $cond: [{ $eq: ["$action", "expired"] },  1, 0] } },
          avgHold:   { $avg: "$holdSeconds" },
          maxHold:   { $max: "$holdSeconds" },
        },
      },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
      { $project: {
          total: 1, called: 1, updated: 1, rejected: 1, breaks: 1, expired: 1,
          avgHold: 1, maxHold: 1,
          name: { $arrayElemAt: ["$u.name", 0] },
      } },
      { $sort: { total: -1 } },
    ]),

    // Every dialled call, with its write-up and the full trail of edits.
    CallSession.find({ ...match, action: "called" })
      .populate("user", "name email")
      .populate("lead", "name phone status")
      .populate("outcomeHistory.recordedBy", "name")
      .sort({ callStartedAt: -1 })
      .limit(300)
      .lean(),

    CallSession.aggregate([
      { $match: { ...match, action: "called" } },
      { $group: { _id: "$outcomeStatus", n: { $sum: 1 } } },
    ]),

    // Every break in the period, with how it ended.
    CallSession.find({ ...match, action: "break" })
      .populate("user", "name email")
      .sort({ respondedAt: -1 })
      .limit(200)
      .lean(),
  ]);

  // Resolve each user's holdAlertMinutes so "over threshold" respects their own
  // schedule rather than a single global number.
  const users = await User.find({ workSchedule: { $ne: null } })
    .populate("workSchedule", "holdAlertMinutes")
    .select("_id workSchedule")
    .lean();
  const thresholdFor = new Map(
    users.map((u) => [
      String(u._id),
      ((u.workSchedule as unknown as { holdAlertMinutes?: number } | null)?.holdAlertMinutes ?? 10) * 60,
    ]),
  );

  const flaggedHolds = longHolds.filter((h) => {
    const limit = thresholdFor.get(String((h.user as { _id?: unknown })?._id ?? h.user)) ?? 600;
    return (h.holdSeconds ?? 0) >= limit;
  });

  const counts = byAction.reduce(
    (a: Record<string, number>, r: { _id: string | null; n: number }) => ({ ...a, [r._id ?? "open"]: r.n }),
    {},
  );

  const outcome = outcomeCounts.reduce(
    (a: Record<string, number>, r: { _id: string | null; n: number }) => ({ ...a, [r._id ?? "none"]: r.n }),
    {},
  );

  // Still being asked whether they are back, or gave up on ever answering.
  const awaitingReturn = breakLog.filter(
    (b) => b.breakReturnPromptedAt && !b.breakReturnedAt && !b.breakReturnClosedAt,
  );
  const unconfirmedReturns = breakLog.filter((b) => !!b.breakReturnClosedAt && !b.breakReturnedAt);

  return {
    counts, rejections, flaggedHolds, activeBreaks, perUser,
    callLog,
    breakLog,
    awaitingReturn,
    unconfirmedReturns,
    outcomeCounts: outcome,
    // Split out so the page can flag them without filtering client-side.
    pendingOutcomes: callLog.filter((c) => c.outcomeStatus === "pending"),
    skippedOutcomes: callLog.filter((c) => c.outcomeStatus === "skipped"),
  };
}

/**
 * Tell every Super Admin that a call session changed, so the Call Automation
 * page updates without waiting for its 30s poll. Fire-and-forget: a failure
 * here must never break the employee's own action.
 */
export async function notifyAdminsOfCallActivity(payload: Record<string, unknown>): Promise<void> {
  try {
    const admins = await User.find({ isActive: true }).populate("role").select("role").lean();
    for (const admin of admins) {
      const role = admin.role as { isSystemRole?: boolean; roleName?: string } | null;
      if (role?.isSystemRole && role?.roleName === "Super Admin") {
        emitToUser(admin._id.toString(), "call:activity", payload);
      }
    }
  } catch (err) {
    console.error("[callAutomation] admin notify failed:", err);
  }
}
