import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { buildPagination } from "../utils/response.js";
import type {
  LeadFilters,
  LeadStatus,
  LeadStats,
  ParsedLead,
  AutoAssignResult,
  ActivityAction,
  IRole,
} from "../types/index.js";

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
    .populate("activityLogs.performedBy", "name email");
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

// ─── LeadService ──────────────────────────────────────────────────────────────

export class LeadService {
  // ── Create ──────────────────────────────────────────────────────────────────
  async createLead(
    data: ParsedLead & { status?: LeadStatus; assignedTo?: string; course?: string | null },
    reporterId: string,
  ) {
    const lead = await Lead.create({
      ...data,
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

    // ── Date range filter on createdAt ──────────────────────────────────────────
    if (filters.dateFrom || filters.dateTo) {
      const dateRange: Record<string, Date> = {};
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom);
        // Start of the given day (00:00:00 UTC)
        from.setUTCHours(0, 0, 0, 0);
        if (!isNaN(from.getTime())) dateRange.$gte = from;
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo);
        // End of the given day (23:59:59.999 UTC)
        to.setUTCHours(23, 59, 59, 999);
        if (!isNaN(to.getTime())) dateRange.$lte = to;
      }
      if (Object.keys(dateRange).length > 0) {
        query.createdAt = dateRange;
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

    Object.assign(lead, data);

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

    addLog(
      lead as never,
      "status_changed",
      `Status changed from "${prevStatus}" to "${status}"`,
      performedById,
      { status: { from: prevStatus, to: status } },
    );

    await lead.save();
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
    console.log("passeddd 4 🔴");

    await lead.save();
    console.log("passeddd 4 🔴");
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
      "rejected",
      "cnc",
      "booking",
      "interested",
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
      rejected: statusCounts[4],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk / Auto-assign
  // ─────────────────────────────────────────────────────────────────────────────

  async bulkCreateLeads(leads: ParsedLead[], reporterId: string) {
    const leadsWithReporter = leads.map((lead) => ({
      ...lead,
      reporter: reporterId,
      notes: {
        content: lead.notes,
        author: reporterId,
        // createdAt: new Date(),
        // updatedAt: new Date(),
      },
      activityLogs: [
        {
          action: "lead_created",
          description: "Lead was created via bulk upload",
          performedBy: reporterId,
          createdAt: new Date(),
        },
      ],
    }));

    const created = await Lead.insertMany(leadsWithReporter, {
      ordered: false,
    });
    return created;
  }

  async autoAssignLeads(leadIds?: string[]): Promise<AutoAssignResult> {
    const query =
      leadIds && leadIds.length > 0
        ? { _id: { $in: leadIds } }
        : { status: "new", team: null };

    const leadsToAssign = await Lead.find(query);
    if (leadsToAssign.length === 0) return { assigned: 0, results: [] };

    const activeTeams = await Team.find({ status: "active" });
    if (activeTeams.length === 0) {
      throw Object.assign(
        new Error("No active teams found for assignment"),
        { statusCode: 404 },
      );
    }

    // Sort teams by current lead count (ascending) for fair distribution
    const teamLeadCounts = await Promise.all(
      activeTeams.map(async (team) => {
        const count = await Lead.countDocuments({ team: team._id });
        return { team, count };
      }),
    );
    teamLeadCounts.sort((a, b) => a.count - b.count);

    const results: { leadId: string; assignedTo: string }[] = [];
    const updates: Promise<unknown>[] = [];

    for (let i = 0; i < leadsToAssign.length; i++) {
      const { team } = teamLeadCounts[i % teamLeadCounts.length];
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
      teamLeadCounts[i % teamLeadCounts.length].count += 1;
    }

    await Promise.all(updates);
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
}
