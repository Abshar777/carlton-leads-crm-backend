import { TrapEvent, type TrapAction } from "../models/TrapEvent.js";
import { User } from "../models/User.js";
import { emitToUser } from "../socket.js";

interface LogTrapParams {
  userId: string;
  action: TrapAction;
  leadId?: string;
  leadName?: string;
  phoneNumber?: string;
  page?: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function logTrapEvent(params: LogTrapParams) {
  const event = await TrapEvent.create({
    user:        params.userId,
    action:      params.action,
    leadId:      params.leadId,
    leadName:    params.leadName,
    phoneNumber: params.phoneNumber,
    page:        params.page,
    ipAddress:   params.ipAddress,
    userAgent:   params.userAgent,
  });

  const populated = await TrapEvent.findById(event._id)
    .populate("user", "name role email")
    .lean();

  // Emit real-time alert to all Super Admins
  const superAdmins = await User.find({ isActive: true })
    .populate("role")
    .lean();

  for (const admin of superAdmins) {
    const role = admin.role as { isSystemRole?: boolean; roleName?: string } | null;
    if (role?.isSystemRole && role?.roleName === "Super Admin") {
      emitToUser(admin._id.toString(), "trap:alert", populated ?? {});
    }
  }

  return populated;
}

export async function getTrapEvents(filters: {
  action?: TrapAction;
  userId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  const query: Record<string, unknown> = {};

  if (filters.action) query.action = filters.action;
  if (filters.userId) query.user = filters.userId;
  if (filters.dateFrom || filters.dateTo) {
    const range: Record<string, Date> = {};
    if (filters.dateFrom) range.$gte = new Date(filters.dateFrom);
    if (filters.dateTo)   range.$lte = new Date(new Date(filters.dateTo).setHours(23, 59, 59, 999));
    query.createdAt = range;
  }

  const page  = filters.page  ?? 1;
  const limit = filters.limit ?? 50;
  const skip  = (page - 1) * limit;

  const [events, total] = await Promise.all([
    TrapEvent.find(query)
      .populate("user", "name email")
      .populate("leadId", "name contactNo")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    TrapEvent.countDocuments(query),
  ]);

  return { events, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getUnreadTrapCount() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
  return TrapEvent.countDocuments({ createdAt: { $gte: since } });
}
