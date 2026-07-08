import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { buildPagination } from "../utils/response.js";
import { emitTeamUpdate, emitToUser } from "../socket.js";
import { sendPushToUsers, notifyLeadAssignment } from "./pushService.js";
import type {
  LeadFilters,
  LeadStatus,
  LeadStats,
  ParsedLead,
  AutoAssignResult,
  ActivityAction,
  CallOutcome,
  IRole,
} from "../types/index.js";

// ─── Phone normalization ──────────────────────────────────────────────────────

/**
 * Normalize a raw phone string to a canonical form for storage & uniqueness.
 *
 * Indian numbers  → 10 digits, no prefix (e.g. "9876543210")
 * International   → "+" + all digits  (e.g. "+971557352483")
 *
 * Returns null if the input cannot be made into a valid number.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits  = trimmed.replace(/\D/g, ""); // strip everything non-digit

  // Indian: strip +91 / 91 / 0 prefix → must leave exactly 10 digits starting 6-9
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]$/.test(digits[2])) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith("0") && /^[6-9]$/.test(digits[1])) {
    return digits.slice(1);
  }
  if (digits.length === 10 && /^[6-9]$/.test(digits[0])) {
    return digits;
  }

  // International (non-Indian +XX...) — keep "+" prefix
  if (hasPlus && digits.length >= 7 && digits.length <= 15) {
    // exclude +91 Indian numbers already handled above
    if (!digits.startsWith("91") || digits.length !== 12) {
      return "+" + digits;
    }
  }

  return null; // invalid
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPopulatedQuery(id: string) {
  return Lead.findById(id)
    .populate("reporter",  "name email designation")
    .populate("assignedTo","name email designation")
    .populate({
      path: "team",
      select: "name status leaders members",
      populate: [
        { path: "leaders", select: "name email designation" },
        { path: "members", select: "name email designation" },
      ],
    })
    .populate("course", "name amount status")
    .populate("notes.author", "name email")
    .populate("activityLogs.performedBy", "name email")
    .populate("tags", "name color");
}

function addLog(
  lead: Awaited<ReturnType<typeof Lead.findById>> & {
    activityLogs: { push: (v: object) => void };
  },
  action: ActivityAction,
  description: string,
  performedBy: string,
  changes?: Record<string, { from: unknown; to: unknown }>,
) {
  lead.activityLogs.push({
    action,
    description,
    performedBy,
    changes,
    createdAt: new Date(),
  } as never);
}

// ── Emit last activity log to the lead's team room ────────────────────────────
async function emitActivity(
  lead: { _id: unknown; name: string; team?: unknown; activityLogs: unknown[] },
) {
  const teamId = lead.team ? String(lead.team) : null;
  if (!teamId) return;
  const log = lead.activityLogs[lead.activityLogs.length - 1] as Record<string, unknown>;
  if (!log) return;

  // Fetch performer name
  const performer = log.performedBy
    ? await User.findById(log.performedBy).select("name email").lean()
    : null;

  emitTeamUpdate(teamId, {
    _id:         String(log._id ?? ""),
    type:        "activity",
    action:      log.action,
    description: log.description,
    performedBy: performer
      ? { _id: String(performer._id), name: performer.name, email: performer.email }
      : null,
    leadId:   String(lead._id),
    leadName: lead.name,
    changes:  log.changes ?? undefined,
    createdAt: (log.createdAt as Date).toISOString(),
  });
}

// ── Notify team leaders about a lead event ────────────────────────────────────
async function notifyTeamLeaders(
  lead: { _id: unknown; name: string; team?: unknown },
  skipUserId: string,
  payload: { title: string; body: string; tag?: string; url?: string; data?: Record<string, unknown> },
) {
  const teamId = lead.team ? String(lead.team) : null;
  if (!teamId) return;

  const teamDoc = await Team.findById(teamId).select("leaders").lean();
  if (!teamDoc) return;

  const leaderIds = (teamDoc.leaders as unknown as { toString(): string }[])
    .map((l) => l.toString())
    .filter((id) => id !== skipUserId);

  for (const lid of leaderIds) {
    emitToUser(lid, "notification", { ...payload, createdAt: new Date().toISOString() });
  }
  sendPushToUsers(leaderIds, payload).catch(() => null);
}

// ── Auto-split a lead to a team member based on team settings ────────────────
async function autoSplitLead(
  teamId: string,
  leadId: string,
  performedById: string,
  overrideMemberIds?: string[],
) {
  try {
    const team = await Team.findById(teamId).populate("members", "_id").populate("leaders", "_id").lean();
    if (!team || !team.settings?.autoAssign) return;

    const allMemberIds = [
      ...team.leaders.map((u: { _id: { toString(): string } }) => u._id.toString()),
      ...team.members.map((u: { _id: { toString(): string } }) => u._id.toString()),
    ].filter((id, i, arr) => arr.indexOf(id) === i); // dedupe

    const inactiveSet = new Set(
      (team.inactiveMembers as unknown as { toString(): string }[]).map((id) => id.toString())
    );

    // Priority: per-upload override → team.settings.includedMembers → all members
    // In all cases, filter to valid active team members only
    let includedSet: string[];
    if (overrideMemberIds && overrideMemberIds.length > 0) {
      includedSet = overrideMemberIds.filter((id) => allMemberIds.includes(id));
    } else {
      includedSet = (team.settings.includedMembers as unknown as { toString(): string }[])
        .map((id) => id.toString())
        .filter((id) => allMemberIds.includes(id));
    }
    const pool = (includedSet.length > 0 ? includedSet : allMemberIds).filter((id) => !inactiveSet.has(id));

    if (pool.length === 0) return;

    let assigneeId: string;

    if (team.settings.splitMode === "equal_load") {
      const counts = await Promise.all(
        pool.map((id) =>
          Lead.countDocuments({ assignedTo: id, status: { $in: ["new", "assigned", "followup", "interested", "cnc", "callback", "rnr", "whatsapp"] } })
        )
      );
      const minIndex = counts.indexOf(Math.min(...counts));
      assigneeId = pool[minIndex];
    } else {
      // round_robin — use stored index, then advance it
      const idx = (team.settings.roundRobinIndex ?? 0) % pool.length;
      assigneeId = pool[idx];
      await Team.updateOne({ _id: teamId }, { $set: { "settings.roundRobinIndex": (idx + 1) % pool.length } });
    }

    const user = await User.findById(assigneeId).select("_id name").lean();
    if (!user) return;

    await Lead.updateOne(
      { _id: leadId },
      { $set: { assignedTo: user._id, status: "assigned", assignedAt: new Date() } }
    );

    // Log the auto-assignment
    await Lead.updateOne(
      { _id: leadId },
      {
        $push: {
          activityLogs: {
            action: "lead_assigned",
            description: `Auto-assigned to "${user.name}" via ${team.settings.splitMode === "equal_load" ? "equal load" : "round robin"}`,
            performedBy: performedById,
            createdAt: new Date(),
          },
        },
      }
    );

    const splitLead = await Lead.findById(leadId).select("name").lean();
    void notifyLeadAssignment(assigneeId, leadId, splitLead?.name ?? "", emitToUser);
  } catch (err) {
    console.error("[autoSplitLead] error:", err);
  }
}

// ─── LeadService ──────────────────────────────────────────────────────────────

export class LeadService {
  // ── Create ──────────────────────────────────────────────────────────────────
  async createLead(
    data: ParsedLead & { status?: LeadStatus; assignedTo?: string; course?: string | null; team?: string | null },
    reporterId: string,
  ) {
    // Normalize + validate phone
    const normalizedPhone = normalizePhone(data.phone);
    if (!normalizedPhone) {
      throw Object.assign(new Error("Invalid phone number. Please enter a valid mobile number."), { statusCode: 400 });
    }

    // Duplicate check
    const existing = await Lead.findOne({ phone: normalizedPhone }).select("_id name phone").lean();
    if (existing) {
      throw Object.assign(
        new Error(`A lead with this phone number already exists (${existing.name}).`),
        { statusCode: 409, existingId: existing._id.toString() },
      );
    }

    // If no team was selected, auto-detect the creator's team so the lead
    // is visible to the team leader and shows up in team-scoped reports.
    let resolvedTeamId = data.team || null;
    if (!resolvedTeamId) {
      const creatorTeam = await Team.findOne({
        $or: [{ members: reporterId }, { leaders: reporterId }],
        status: "active",
      }).select("_id").lean();
      if (creatorTeam) {
        resolvedTeamId = creatorTeam._id.toString();
      }
    }

    const lead = await Lead.create({
      ...data,
      phone: normalizedPhone,
      team: resolvedTeamId,
      assignedAt: data.assignedTo ? new Date() : null,
      reporter: reporterId,
      activityLogs: [
        {
          action: "lead_created",
          description: "Lead was created",
          performedBy: reporterId,
          createdAt: new Date(),
        },
      ],
    });

    return buildPopulatedQuery(lead._id.toString());
  }

  // ── List ─────────────────────────────────────────────────────────────────────
  async getLeads(filters: LeadFilters, userId?: string, userRole?: IRole) {
    const page = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(filters.limit ?? "10", 10)),
    );
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    // console.log( (userRole?.roleName === "Super Admin" || userRole?.roleName === "Reporter"),userRole,"NAKANANKA" )
    // ── Role-scoped visibility ────────────────────────────────────────────────
    const isSuperAdmin =(userRole?.roleName === "Super Admin" || userRole?.roleName === "Reporter");

    if (!isSuperAdmin && userId) {
      // Check if the user is a leader of any team
      const leaderTeam = await Team.findOne({ leaders: userId }).select("_id");

      if (leaderTeam) {
        // Team leader: scoped to their team only
        query.team = leaderTeam._id;
      } else {
        // Regular member / BDE / any non-admin role: only their assigned leads
        query.assignedTo = userId;
      }
    }
   
    if (filters.status)     query.status     = filters.status;
    if (filters.assignedTo) query.assignedTo = filters.assignedTo;
    if (filters.team)       query.team       = filters.team;
    if (filters.reporter)   query.reporter   = filters.reporter;
    if (filters.course)     query.course     = filters.course;
    if (filters.tags) {
      const tagIds = filters.tags.split(",").filter(Boolean);
      if (tagIds.length > 0) query.tags = { $in: tagIds };
    }

    // ── Date range filter on createdAt (IST-aware) ──────────────────────────────
    // Append +05:30 so JS parses the date as IST midnight, not UTC midnight.
    // Without this, "2026-05-07" → 2026-05-07T00:00:00Z which is 05:30 AM IST —
    // causing leads from the first 5.5 hrs of the next IST day to appear.
    if (filters.dateFrom || filters.dateTo) {
      const dateRange: Record<string, Date> = {};
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom + "T00:00:00.000+05:30");
        if (!isNaN(from.getTime())) dateRange.$gte = from;
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo + "T23:59:59.999+05:30");
        if (!isNaN(to.getTime())) dateRange.$lte = to;
      }
      if (Object.keys(dateRange).length > 0) {
        query.createdAt = dateRange;
      }
    }

    // ── Date range filter on updatedAt / last updated (IST-aware) ───────────────
    if (filters.updatedFrom || filters.updatedTo) {
      const updatedRange: Record<string, Date> = {};
      if (filters.updatedFrom) {
        const from = new Date(filters.updatedFrom + "T00:00:00.000+05:30");
        if (!isNaN(from.getTime())) updatedRange.$gte = from;
      }
      if (filters.updatedTo) {
        const to = new Date(filters.updatedTo + "T23:59:59.999+05:30");
        if (!isNaN(to.getTime())) updatedRange.$lte = to;
      }
      if (Object.keys(updatedRange).length > 0) {
        query.updatedAt = updatedRange;
      }
    }

    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    const sortField = filters.sortBy ?? "createdAt";
    const sortOrder = filters.sortOrder === "asc" ? 1 : -1;

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate("reporter",  "name email")
        .populate("assignedTo","name email")
        .populate("team",      "name status")
        .populate("course",    "name amount status")
        .populate("tags",      "name color")
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .select("-activityLogs -notes")
        .lean(),
      Lead.countDocuments(query),
    ]);

    return { leads, pagination: buildPagination(total, page, limit) };
  }

  // ── Get by ID (full detail with notes + logs) ────────────────────────────────
  async getLeadById(id: string) {
    const lead = await buildPopulatedQuery(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    return lead;
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  async updateLead(
    id: string,
    data: Partial<
      ParsedLead & { status?: LeadStatus; assignedTo?: string | null; course?: string | null }
    >,
    performedById: string,
  ) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    // Normalize + dedupe phone if it's being updated
    if (data.phone) {
      const normalizedPhone = normalizePhone(data.phone);
      if (!normalizedPhone) {
        throw Object.assign(new Error("Invalid phone number. Please enter a valid mobile number."), { statusCode: 400 });
      }
      if (normalizedPhone !== lead.phone) {
        const clash = await Lead.findOne({ phone: normalizedPhone, _id: { $ne: lead._id } }).select("_id name").lean();
        if (clash) {
          throw Object.assign(
            new Error(`Phone number already used by another lead (${clash.name}).`),
            { statusCode: 409 },
          );
        }
      }
      data.phone = normalizedPhone;
    }

    // Track field changes for the log
    const trackedFields: Array<keyof typeof data> = [
      "name",
      "email",
      "phone",
      "source",
      "course",
      "status",
    ];
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const field of trackedFields) {
      if (data[field] !== undefined) {
        const prev = (lead as unknown as Record<string, unknown>)[field];
        const next = data[field];
        if (String(prev ?? "") !== String(next ?? "")) {
          changes[field] = { from: prev, to: next };
        }
      }
    }

    const prevAssignedTo = lead.assignedTo?.toString() ?? null;

    Object.assign(lead, data);

    // Stamp assignedAt whenever assignedTo is set or changed
    const newAssignee = data.assignedTo ? String(data.assignedTo) : undefined;
    if (newAssignee && newAssignee !== prevAssignedTo) {
      (lead as unknown as Record<string, unknown>).assignedAt = new Date();
    } else if (data.assignedTo === null) {
      (lead as unknown as Record<string, unknown>).assignedAt = null;
    }

    const changedFields = Object.keys(changes);
    if (changedFields.length > 0) {
      addLog(
        lead as never,
        "lead_updated",
        `Updated field(s): ${changedFields.join(", ")}`,
        performedById,
        changes,
      );
    }

    await lead.save();

    // If assignedTo changed, notify the new assignee
    const newAssignedTo = data.assignedTo ? String(data.assignedTo) : null;
    if (newAssignedTo && newAssignedTo !== prevAssignedTo) {
      void notifyLeadAssignment(newAssignedTo, String(lead._id), lead.name, emitToUser).catch(() => null);
    }

    return buildPopulatedQuery(id);
  }

  // ── Update Status ────────────────────────────────────────────────────────────
  async updateLeadStatus(
    id: string,
    status: LeadStatus,
    performedById: string,
  ) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const prevStatus = lead.status;
    lead.status = status;

    // Stamp cncAt whenever status becomes CNC so the reset scheduler knows when to resurface it
    if (status === "cnc") {
      lead.cncAt = new Date();
    } else if (prevStatus === "cnc") {
      lead.cncAt = null; // cleared when manually moved out of CNC
    }

    addLog(
      lead as never,
      "status_changed",
      `Status changed from "${prevStatus}" to "${status}"`,
      performedById,
      { status: { from: prevStatus, to: status } },
    );

    await lead.save();
    void emitActivity(lead as never);
    // Notify team leaders of status change
    void notifyTeamLeaders(lead as never, performedById, {
      title: "Lead Status Updated",
      body: `${lead.name}: status changed to "${status}"`,
      tag: `status-${String(lead._id)}`,
      url: `/leads/${String(lead._id)}`,
      data: { type: "status_changed", leadId: String(lead._id) },
    });
    return buildPopulatedQuery(id);
  }

  // ── Assign ───────────────────────────────────────────────────────────────────
  async assignLead(id: string, userId: string, performedById: string) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const user = await User.findById(userId);
    if (!user)
      throw Object.assign(new Error("User not found"), { statusCode: 404 });

    const prevAssignee = lead.assignedTo?.toString() ?? null;
    lead.assignedTo = user._id;
    lead.status = "assigned";
    (lead as unknown as Record<string, unknown>).assignedAt = new Date();

    addLog(
      lead as never,
      "lead_assigned",
      `Lead assigned to ${user.name}`,
      performedById,
      {
        assignedTo: { from: prevAssignee, to: user._id.toString() },
        status: { from: lead.status, to: "assigned" },
      },
    );

    await lead.save();
    void emitActivity(lead as never);
    return buildPopulatedQuery(id);
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async deleteLead(id: string) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    await Lead.findByIdAndDelete(id);
    return { message: "Lead deleted successfully" };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Notes
  // ─────────────────────────────────────────────────────────────────────────────

  async addNote(leadId: string, content: string, authorId: string) {
    const lead = await Lead.findById(leadId);
    console.log("passeddd 🔴", lead);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    console.log("passeddd 2 🔴");
    lead.notes.push({
      content,
      author: authorId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    console.log("passeddd 3 🔴");

    addLog(lead as never, "note_added", "A note was added", authorId, { note: { from: null, to: content } });

    await lead.save();
    void emitActivity(lead as never);
    // Notify team leaders of new note
    void notifyTeamLeaders(lead as never, authorId, {
      title: "Note Added",
      body: `${lead.name}: ${content.length > 80 ? content.slice(0, 80) + "…" : content}`,
      tag: `note-${String(lead._id)}`,
      url: `/leads/${String(lead._id)}`,
      data: { type: "note_added", leadId: String(lead._id) },
    });
    return buildPopulatedQuery(leadId);
  }

  async updateNote(
    leadId: string,
    noteId: string,
    content: string,
    performedById: string,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const note = lead.notes.id(noteId);
    if (!note)
      throw Object.assign(new Error("Note not found"), { statusCode: 404 });

    // Only the note author can edit their note
    if (note.author.toString() !== performedById) {
      throw Object.assign(new Error("Not authorised to edit this note"), {
        statusCode: 403,
      });
    }

    note.content = content;
    (note as unknown as { updatedAt: Date }).updatedAt = new Date();

    addLog(lead as never, "note_updated", "A note was updated", performedById, { note: { from: null, to: content } });

    await lead.save();
    void emitActivity(lead as never);
    return buildPopulatedQuery(leadId);
  }

  async deleteNote(
    leadId: string,
    noteId: string,
    performedById: string,
    isSuperAdmin = false,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const note = lead.notes.id(noteId);
    if (!note)
      throw Object.assign(new Error("Note not found"), { statusCode: 404 });

    // Only note author or super-admin can delete
    if (!isSuperAdmin && note.author.toString() !== performedById) {
      throw Object.assign(new Error("Not authorised to delete this note"), {
        statusCode: 403,
      });
    }

    note.deleteOne();

    addLog(lead as never, "note_deleted", "A note was deleted", performedById);

    await lead.save();
    return buildPopulatedQuery(leadId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // User-scoped queries
  // ─────────────────────────────────────────────────────────────────────────────

  async getLeadsByUser(userId: string, filters: LeadFilters) {
    const page = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(filters.limit ?? "10", 10)),
    );
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { assignedTo: userId };
    if (filters.status) query.status = filters.status;

    // ── Date range filter on createdAt (IST-aware) ──────────────────────────────
    if (filters.dateFrom || filters.dateTo) {
      const dateRange: Record<string, Date> = {};
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom + "T00:00:00.000+05:30");
        if (!isNaN(from.getTime())) dateRange.$gte = from;
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo + "T23:59:59.999+05:30");
        if (!isNaN(to.getTime())) dateRange.$lte = to;
      }
      if (Object.keys(dateRange).length > 0) query.createdAt = dateRange;
    }

    // ── Date range filter on updatedAt / last updated (IST-aware) ───────────────
    if (filters.updatedFrom || filters.updatedTo) {
      const updatedRange: Record<string, Date> = {};
      if (filters.updatedFrom) {
        const from = new Date(filters.updatedFrom + "T00:00:00.000+05:30");
        if (!isNaN(from.getTime())) updatedRange.$gte = from;
      }
      if (filters.updatedTo) {
        const to = new Date(filters.updatedTo + "T23:59:59.999+05:30");
        if (!isNaN(to.getTime())) updatedRange.$lte = to;
      }
      if (Object.keys(updatedRange).length > 0) query.updatedAt = updatedRange;
    }

    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    const sortField = filters.sortBy ?? "createdAt";
    const sortOrder = filters.sortOrder === "asc" ? 1 : -1;

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate("reporter", "name email")
        .populate("assignedTo", "name email")
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .select("-activityLogs")
        .lean(),
      Lead.countDocuments(query),
    ]);

    return { leads, pagination: buildPagination(total, page, limit) };
  }

  async getUserLeadStats(userId: string): Promise<LeadStats> {
    const statuses: LeadStatus[] = [
      "new",
      "assigned",
      "followup",
      "closed",
      "invalid",
      "cnc",
      "booking",
      "notinterested",
      "interested",
      "rnr",
      "callback",
      "whatsapp",
      "student",
    ];
    const [total, ...statusCounts] = await Promise.all([
      Lead.countDocuments({ assignedTo: userId }),
      ...statuses.map((s) =>
        Lead.countDocuments({ assignedTo: userId, status: s }),
      ),
    ]);

    return {
      total,
      new: statusCounts[0],
      assigned: statusCounts[1],
      followup: statusCounts[2],
      closed: statusCounts[3],
      invalid: statusCounts[4],
      cnc: statusCounts[5],
      booking: statusCounts[6],
      notinterested: statusCounts[7],
      interested: statusCounts[8],
      rnr: statusCounts[9],
      callback: statusCounts[10],
      whatsapp: statusCounts[11],
      student: statusCounts[12],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk / Auto-assign
  // ─────────────────────────────────────────────────────────────────────────────

  async bulkCreateLeads(leads: ParsedLead[], reporterId: string) {
    const EMAIL_RE = /^\S+@\S+\.\S+$/;

    // 1. Normalize phones + dedupe within the batch (keep first occurrence)
    const seenInBatch = new Set<string>();
    const validLeads: (ParsedLead & { _normalizedPhone: string })[] = [];
    const skippedInvalid: string[] = [];

    for (const lead of leads) {
      const normalized = normalizePhone(lead.phone);
      if (!normalized) {
        skippedInvalid.push(lead.phone);
        continue;
      }
      if (seenInBatch.has(normalized)) continue; // duplicate within batch
      seenInBatch.add(normalized);
      validLeads.push({ ...lead, phone: normalized, _normalizedPhone: normalized });
    }

    // 2. Single query to find all phones already in DB
    const allNormalized = validLeads.map((l) => l._normalizedPhone);
    const existingInDB = await Lead.find({ phone: { $in: allNormalized } })
      .select("phone")
      .lean();
    const existingPhones = new Set(existingInDB.map((l) => l.phone));

    // 3. Filter out DB duplicates
    const toInsert = validLeads.filter((l) => !existingPhones.has(l._normalizedPhone));
    const skippedDuplicates = validLeads
      .filter((l) => existingPhones.has(l._normalizedPhone))
      .map((l) => l._normalizedPhone);

    if (toInsert.length === 0) {
      return { inserted: [], skipped: skippedDuplicates.length + skippedInvalid.length, skippedPhones: [...skippedDuplicates, ...skippedInvalid] };
    }

    const leadsWithReporter = toInsert.map(({ _normalizedPhone: _, ...lead }) => {
      const email =
        lead.email && EMAIL_RE.test(lead.email.trim())
          ? lead.email.trim().toLowerCase()
          : undefined;

      return {
        ...lead,
        email,
        reporter: reporterId,
        notes: lead.notes
          ? [{ content: lead.notes, author: reporterId }]
          : [],
        activityLogs: [
          {
            action: "lead_created",
            description: "Lead was created via bulk upload",
            performedBy: reporterId,
            createdAt: new Date(),
          },
        ],
      };
    });

    const created = await Lead.insertMany(leadsWithReporter, { ordered: false });
    return { inserted: created, skipped: skippedDuplicates.length + skippedInvalid.length, skippedPhones: [...skippedDuplicates, ...skippedInvalid] };
  }

  async autoAssignLeads(leadIds?: string[], teamIds?: string[], memberOverrides?: Record<string, string[]>): Promise<AutoAssignResult> {
    // Empty array means "no teams selected → skip auto-assign entirely"
    if (Array.isArray(teamIds) && teamIds.length === 0) {
      return { assigned: 0, results: [] };
    }

    const query =
      leadIds && leadIds.length > 0
        ? { _id: { $in: leadIds } }
        : { status: "new", team: null };

    const leadsToAssign = await Lead.find(query);
    if (leadsToAssign.length === 0) return { assigned: 0, results: [] };

    // If specific team IDs supplied, restrict to those teams only
    const teamFilter =
      teamIds && teamIds.length > 0
        ? { status: "active", _id: { $in: teamIds } }
        : { status: "active" };

    const activeTeams = await Team.find(teamFilter);
    if (activeTeams.length === 0) {
      // When caller specified specific teams but none matched / inactive, skip silently
      if (teamIds && teamIds.length > 0) return { assigned: 0, results: [] };
      throw Object.assign(
        new Error("No active teams found for assignment"),
        { statusCode: 404 },
      );
    }

    // Count THIS MONTH's leads per team — fair monthly balancing (resets each month)
    const assignNow = new Date();
    const assignMonthStart = new Date(Date.UTC(assignNow.getUTCFullYear(), assignNow.getUTCMonth(), 1));

    const teamLeadCounts = await Promise.all(
      activeTeams.map(async (team) => {
        const count = await Lead.countDocuments({
          team: team._id,
          createdAt: { $gte: assignMonthStart },
        });
        return { team, count };
      }),
    );
    teamLeadCounts.sort((a, b) => a.count - b.count);

    // Build assignment list: one team entry per lead using fill-to-equal logic
    // Phase 1 — fill each team below the ceiling (max) up to the ceiling
    // Phase 2 — round-robin any remaining leads
    const n = teamLeadCounts.length;
    const maxLoad = teamLeadCounts[n - 1].count;
    const assignedTeams: (typeof teamLeadCounts[0])[] = [];

    // Phase 1
    for (let i = 0; i < n - 1 && assignedTeams.length < leadsToAssign.length; i++) {
      const gap  = maxLoad - teamLeadCounts[i].count;
      const give = Math.min(gap, leadsToAssign.length - assignedTeams.length);
      for (let g = 0; g < give; g++) {
        assignedTeams.push(teamLeadCounts[i]);
        teamLeadCounts[i].count++;
      }
    }

    // Phase 2 — round-robin remainder
    let rr = 0;
    while (assignedTeams.length < leadsToAssign.length) {
      assignedTeams.push(teamLeadCounts[rr % n]);
      teamLeadCounts[rr % n].count++;
      rr++;
    }

    const results: { leadId: string; assignedTo: string }[] = [];
    const updates: Promise<unknown>[] = [];

    for (let i = 0; i < leadsToAssign.length; i++) {
      const { team } = assignedTeams[i];
      const lead = leadsToAssign[i];

      updates.push(
        Lead.findByIdAndUpdate(lead._id, {
          $set: { team: team._id, status: "new" },
          $push: {
            activityLogs: {
              action: "team_assigned",
              description: `Auto-assigned to team "${team.name}"`,
              performedBy: lead.reporter,
              createdAt: new Date(),
            },
          },
        }),
      );

      results.push({
        leadId: lead._id.toString(),
        assignedTo: team._id.toString(),
      });
    }

    await Promise.all(updates);

    // ── Trigger intra-team auto-split for every lead that was just assigned a team
    await Promise.all(
      leadsToAssign.map((lead, i) =>
        autoSplitLead(
          assignedTeams[i].team._id.toString(),
          lead._id.toString(),
          lead.reporter?.toString() ?? "",
          memberOverrides?.[assignedTeams[i].team._id.toString()],
        )
      )
    );

    return { assigned: results.length, results };
  }

  // ── Assign Lead to Team ───────────────────────────────────────────────────────
  async assignLeadToTeam(leadId: string, teamId: string, performedById: string) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const team = await Team.findById(teamId);
    if (!team)
      throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const prevTeamId = lead.team?.toString() ?? null;

    // Clear member assignment when reassigning to a (possibly different) team
    lead.team = team._id;
    (lead as unknown as Record<string, unknown>).assignedTo = null;
    lead.status = "new";

    addLog(
      lead as never,
      "team_assigned",
      `Lead assigned to team "${team.name}"`,
      performedById,
      {
        team:       { from: prevTeamId, to: team._id.toString() },
        assignedTo: { from: lead.assignedTo?.toString() ?? null, to: null },
      },
    );

    await lead.save();
    await autoSplitLead(teamId, leadId, performedById);
    return buildPopulatedQuery(leadId);
  }

  // ── Transfer Lead to Another Team ────────────────────────────────────────────
  async transferLeadToTeam(leadId: string, newTeamId: string, performedById: string) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const newTeam = await Team.findById(newTeamId);
    if (!newTeam)
      throw Object.assign(new Error("Target team not found"), { statusCode: 404 });

    const prevTeamId    = lead.team?.toString() ?? null;
    const prevAssigneeId = lead.assignedTo?.toString() ?? null;

    if (prevTeamId === newTeamId)
      throw Object.assign(new Error("Lead is already in this team"), { statusCode: 400 });

    lead.team = newTeam._id;
    (lead as unknown as Record<string, unknown>).assignedTo = null;
    lead.status = "new";

    addLog(
      lead as never,
      "team_assigned",
      `Lead transferred to team "${newTeam.name}"`,
      performedById,
      {
        team:       { from: prevTeamId,     to: newTeam._id.toString() },
        assignedTo: { from: prevAssigneeId, to: null },
      },
    );

    await lead.save();
    await autoSplitLead(newTeamId, leadId, performedById);
    return buildPopulatedQuery(leadId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk operations
  // ─────────────────────────────────────────────────────────────────────────────

  /** Bulk-update status for multiple leads, adding an activity log to each */
  async bulkUpdateStatus(
    leadIds: string[],
    status: LeadStatus,
    performedById: string,
  ) {
    const leads = await Lead.find({ _id: { $in: leadIds } });
    await Promise.all(
      leads.map(async (lead) => {
        const prev = lead.status;
        if (prev === status) return;
        lead.status = status;
        addLog(
          lead as never,
          "status_changed",
          `Status bulk-changed from "${prev}" to "${status}"`,
          performedById,
          { status: { from: prev, to: status } },
        );
        return lead.save();
      }),
    );
    return { updated: leads.length };
  }

  /** Bulk-delete multiple leads */
  async bulkDelete(leadIds: string[]) {
    const result = await Lead.deleteMany({ _id: { $in: leadIds } });
    return { deleted: result.deletedCount };
  }

  /** Bulk-assign multiple leads to a team (clears member assignment) */
  async bulkAssignToTeam(
    leadIds: string[],
    teamId: string,
    performedById: string,
  ) {
    const team = await Team.findById(teamId);
    if (!team)
      throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const leads = await Lead.find({ _id: { $in: leadIds } });
    await Promise.all(
      leads.map(async (lead) => {
        const prevTeam = lead.team?.toString() ?? null;
        lead.team = team._id;
        (lead as unknown as Record<string, unknown>).assignedTo = null;
        lead.status = "new";
        addLog(
          lead as never,
          "team_assigned",
          `Bulk-assigned to team "${team.name}"`,
          performedById,
          { team: { from: prevTeam, to: team._id.toString() } },
        );
        return lead.save();
      }),
    );

    // ── Trigger intra-team auto-split for each lead moved to this team
    await Promise.all(
      leads.map(lead => autoSplitLead(teamId, lead._id.toString(), performedById))
    );

    return { updated: leads.length };
  }

  // get leads by phonenumber
  async getLeadsByPhoneNumber(phoneNumber: string) {
    if (!phoneNumber)
      throw Object.assign(new Error("Phone number is required"), {
        statusCode: 400,
      });
    const leads = await Lead.findOne({ phone: phoneNumber });
    return leads;
  }

  // ─── Call Log ────────────────────────────────────────────────────────────────

  async addCallLog(
    leadId: string,
    calledById: string,
    outcome: CallOutcome,
    duration: number,
    notes?: string,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    // Push call log entry
    lead.callLogs.push({
      calledAt: new Date(),
      duration: Math.max(0, Math.round(duration)),
      outcome,
      notes: notes?.trim() || undefined,
      calledBy: calledById,
    } as never);

    // Auto-increment the appropriate counter
    if (outcome === "connected") {
      lead.callCount = (lead.callCount ?? 0) + 1;
    } else if (outcome === "not_connected") {
      lead.callNotConnected = (lead.callNotConnected ?? 0) + 1;
    }

    // Activity log
    const outcomeLabel =
      outcome === "connected"
        ? "Call connected"
        : outcome === "not_connected"
          ? "Call not connected"
          : "Voicemail";

    addLog(
      lead as never,
      "call_made",
      `${outcomeLabel} — ${Math.floor(duration / 60)}m ${duration % 60}s`,
      calledById,
    );

    await lead.save();
    return buildPopulatedQuery(leadId).lean();
  }

  // ── Today's Queue ─────────────────────────────────────────────────────────────
  async getMyQueue(userId: string) {
    // Start of today in IST (UTC+5:30)
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const todayISTMidnight = new Date(
      Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - istOffsetMs
    );

    const [assigned, cnc] = await Promise.all([
      // Assigned leads for this user (any assigned leads, not just today's)
      Lead.find({ assignedTo: userId, status: "assigned" })
        .populate("course", "name")
        .populate("tags", "name color")
        .populate("assignedTo", "name")
        .sort({ assignedAt: -1 })
        .lean(),

      // CNC leads assigned to this user that were marked CNC before today (due for recall)
      Lead.find({
        assignedTo: userId,
        status: "cnc",
        cncAt: { $lt: todayISTMidnight },
      })
        .populate("course", "name")
        .populate("tags", "name color")
        .populate("assignedTo", "name")
        .sort({ cncAt: 1 })
        .lean(),
    ]);

    return { assigned, cnc, totalCount: assigned.length + cnc.length };
  }
}
