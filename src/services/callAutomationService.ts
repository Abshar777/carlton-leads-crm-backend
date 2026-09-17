import { CallSession } from "../models/CallSession.js";
import { WorkSchedule, DAY_KEYS } from "../models/WorkSchedule.js";
import { User } from "../models/User.js";
import { Lead } from "../models/Lead.js";
import { emitToUser } from "../socket.js";

/** Statuses that make a lead worth calling. */
export const CALLABLE_STATUSES = ["assigned", "cnc", "followup", "interested", "rnr"];

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

/** The next lead this user should call, or null when their queue is empty. */
export async function nextLeadFor(userId: string) {
  return Lead.findOne({ assignedTo: userId, status: { $in: CALLABLE_STATUSES } })
    .sort({ updatedAt: 1 })            // least recently touched first
    .select("name phone status")
    .lean();
}

/** The user's open prompt, if one is waiting on them. */
export function openSessionFor(userId: string) {
  return CallSession.findOne({ user: userId, action: null }).sort({ promptedAt: -1 });
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
      const open = await openSessionFor(userId);
      if (open) {
        open.action = "expired";
        open.respondedAt = now;
        open.holdSeconds = Math.round((now.getTime() - open.promptedAt.getTime()) / 1000);
        await open.save();
        expired += 1;
      }
      continue;
    }

    if (await openSessionFor(userId)) continue;        // already waiting on them
    if (await onBreak(userId)) continue;

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
