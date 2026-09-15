import { WorkSchedule, DAY_KEYS, DAY_MODES } from "../models/WorkSchedule.js";
import { User } from "../models/User.js";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

export interface WorkScheduleInput {
  name: string;
  description?: string;
  loginTime: string;
  logoutTime: string;
  breakStart?: string;
  breakEnd?: string;
  halfDayLogoutTime?: string;
  workDays: Record<string, string>;
  graceMinutes?: number;
  isActive?: boolean;
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

/** Shared validation. Overnight shifts are allowed, so login/logout order is not checked. */
function validate(input: WorkScheduleInput) {
  for (const [label, v] of [
    ["Login time", input.loginTime],
    ["Logout time", input.logoutTime],
    ["Break start", input.breakStart],
    ["Break end", input.breakEnd],
    ["Half-day logout time", input.halfDayLogoutTime],
  ] as [string, string | undefined][]) {
    if (v && !TIME_RE.test(v)) bad(`${label} must be in HH:mm format`);
  }
  if (!input.loginTime || !input.logoutTime) bad("Login and logout times are required");

  if ((input.breakStart && !input.breakEnd) || (input.breakEnd && !input.breakStart)) {
    bad("A break needs both a start and an end");
  }
  if (input.breakStart && input.breakEnd && mins(input.breakEnd) <= mins(input.breakStart)) {
    bad("Break end must be after break start");
  }

  for (const d of DAY_KEYS) {
    const mode = input.workDays?.[d];
    if (mode && !DAY_MODES.includes(mode as never)) bad(`Invalid mode "${mode}" for ${d}`);
  }
  if (!DAY_KEYS.some((d) => input.workDays?.[d] && input.workDays[d] !== "off")) {
    bad("A schedule needs at least one working day");
  }
  if (DAY_KEYS.some((d) => input.workDays?.[d] === "half") && !input.halfDayLogoutTime) {
    bad("A half day needs a half-day logout time");
  }
}

export class WorkScheduleService {
  async list(includeInactive = false) {
    const query = includeInactive ? {} : { isActive: true };
    const schedules = await WorkSchedule.find(query).sort({ name: 1 }).lean();

    // How many users each schedule is assigned to — shown in the list and used
    // to block deleting one that is in use.
    const counts = await User.aggregate([
      { $match: { workSchedule: { $ne: null } } },
      { $group: { _id: "$workSchedule", n: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c: { _id: unknown; n: number }) => [String(c._id), c.n]));

    return schedules.map((s) => ({ ...s, assignedCount: byId.get(String(s._id)) ?? 0 }));
  }

  async create(input: WorkScheduleInput) {
    validate(input);
    const existing = await WorkSchedule.findOne({ name: input.name.trim() }).lean();
    if (existing) throw Object.assign(new Error("A schedule with this name already exists"), { statusCode: 409 });
    return WorkSchedule.create({ ...input, name: input.name.trim() });
  }

  async update(id: string, input: WorkScheduleInput) {
    validate(input);
    const clash = await WorkSchedule.findOne({ name: input.name.trim(), _id: { $ne: id } }).lean();
    if (clash) throw Object.assign(new Error("A schedule with this name already exists"), { statusCode: 409 });

    const updated = await WorkSchedule.findByIdAndUpdate(
      id,
      { $set: { ...input, name: input.name.trim() } },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw Object.assign(new Error("Schedule not found"), { statusCode: 404 });
    return updated;
  }

  async remove(id: string) {
    // Refuse rather than silently stripping the schedule off everyone using it
    const inUse = await User.countDocuments({ workSchedule: id });
    if (inUse > 0) {
      throw Object.assign(
        new Error(`This schedule is assigned to ${inUse} user${inUse === 1 ? "" : "s"}. Reassign them first.`),
        { statusCode: 409 },
      );
    }
    const deleted = await WorkSchedule.findByIdAndDelete(id).lean();
    if (!deleted) throw Object.assign(new Error("Schedule not found"), { statusCode: 404 });
    return { deleted: true };
  }

  /** Assign a schedule to a user, or pass null to clear it. */
  async assign(userId: string, scheduleId: string | null) {
    if (scheduleId) {
      const exists = await WorkSchedule.findById(scheduleId).select("_id").lean();
      if (!exists) throw Object.assign(new Error("Schedule not found"), { statusCode: 404 });
    }
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { workSchedule: scheduleId } },
      { new: true },
    )
      .populate("role", "roleName")
      .populate("workSchedule")
      .lean();
    if (!user) throw Object.assign(new Error("User not found"), { statusCode: 404 });
    return user;
  }
}
