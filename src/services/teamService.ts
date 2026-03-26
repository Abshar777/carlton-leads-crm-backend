import mongoose from "mongoose";
import { Team } from "../models/Team.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { TeamMessage } from "../models/TeamMessage.js";
import { buildPagination } from "../utils/response.js";
import type { TeamFilters, ITeam, IUser } from "../types/index.js";

// ─── Populated query helper ───────────────────────────────────────────────────

function populatedTeam(id: string) {
  return Team.findById(id)
    .populate("leaders", "name email designation status")
    .populate("members", "name email designation status");
}

// ─── TeamService ──────────────────────────────────────────────────────────────

export class TeamService {
  // ── Create ──────────────────────────────────────────────────────────────────
  async createTeam(data: {
    name: string;
    description?: string;
    leaders?: string[];
    members?: string[];
    status?: "active" | "inactive";
  }) {
    const existing = await Team.findOne({ name: data.name.trim() });
    if (existing) throw Object.assign(new Error("A team with this name already exists"), { statusCode: 409 });

    const team = await Team.create(data);
    return populatedTeam(team._id.toString());
  }

  // ── My Team (for regular users / team leaders) ───────────────────────────────
  async getTeamByMember(userId: string) {
    const uid = new mongoose.Types.ObjectId(userId);
    const team = await Team.findOne({
      $or: [{ leaders: uid }, { members: uid }],
    })
      .populate("leaders", "name email designation status")
      .populate("members", "name email designation status")
      .lean();

    return team ?? null;
  }

  // ── List ─────────────────────────────────────────────────────────────────────
  async getTeams(filters: TeamFilters) {
    const page  = Math.max(1, parseInt(filters.page  ?? "1",  10));
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? "10", 10)));
    const skip  = (page - 1) * limit;

    const query: Record<string, unknown> = {};
    if (filters.status && filters.status !== "all") query.status = filters.status;
    if (filters.search) {
      query.name = new RegExp(filters.search, "i");
    }
    
    

    const [teams, total] = await Promise.all([
      Team.find(query)
        .populate("leaders", "name email designation")
        .populate("members", "name email designation")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Team.countDocuments(query),
    ]);

    // Append lead counts per team
    const teamIds = teams.map((t) => (t as unknown as ITeam & { _id: { toString(): string } })._id.toString());
    const leadCounts = await Promise.all(
      teamIds.map(async (id) => ({
        teamId: id,
        total:      await Lead.countDocuments({ team: id }),
        unassigned: await Lead.countDocuments({ team: id, assignedTo: null }),
      }))
    );
    const countMap = Object.fromEntries(leadCounts.map((c) => [c.teamId, c]));

    const enriched = teams.map((t) => {
      const id = (t as { _id: { toString(): string } })._id.toString();
      return { ...t, leadStats: countMap[id] ?? { total: 0, unassigned: 0 } };
    });

    return { teams: enriched, pagination: buildPagination(total, page, limit) };
  }

  // ── Get by ID ─────────────────────────────────────────────────────────────────
  async getTeamById(id: string) {
    const team = await populatedTeam(id);
    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const [total, unassigned] = await Promise.all([
      Lead.countDocuments({ team: id }),
      Lead.countDocuments({ team: id, assignedTo: null }),
    ]);

    return { ...team.toObject(), leadStats: { total, unassigned } };
  }

  // ── Update ────────────────────────────────────────────────────────────────────
  async updateTeam(
    id: string,
    data: {
      name?: string;
      description?: string;
      leaders?: string[];
      members?: string[];
      status?: "active" | "inactive";
    }
  ) {
    const team = await Team.findById(id);
    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    if (data.name && data.name.trim() !== team.name) {
      const dup = await Team.findOne({ name: data.name.trim(), _id: { $ne: id } });
      if (dup) throw Object.assign(new Error("A team with this name already exists"), { statusCode: 409 });
    }

    Object.assign(team, data);
    await team.save();
    return populatedTeam(id);
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  async deleteTeam(id: string) {
    const team = await Team.findById(id);
    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    // Unlink leads from this team before deleting
    await Lead.updateMany({ team: id }, { $set: { team: null } });
    await Team.findByIdAndDelete(id);
    return { message: "Team deleted successfully" };
  }

  // ── Get team leads ────────────────────────────────────────────────────────────
  async getTeamLeads(
    teamId: string,
    filters: {
      status?: string;
      assignedTo?: string;
      reporter?: string;
      search?: string;
      page?: string;
      limit?: string;
      unassignedOnly?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    const page  = Math.max(1, parseInt(filters.page  ?? "1",  10));
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? "10", 10)));
    const skip  = (page - 1) * limit;

    const query: Record<string, unknown> = { team: teamId };
    if (filters.status && filters.status !== "all") query.status = filters.status;
    if (filters.assignedTo && filters.assignedTo !== "all") query.assignedTo = filters.assignedTo;
    if (filters.reporter   && filters.reporter   !== "all") query.reporter   = filters.reporter;
    if (filters.unassignedOnly === "true") query.assignedTo = null;
    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    // Date range filter (UTC-normalised, same as main leads)
    if (filters.dateFrom || filters.dateTo) {
      const dateRange: Record<string, Date> = {};
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom);
        from.setUTCHours(0, 0, 0, 0);
        if (!isNaN(from.getTime())) dateRange.$gte = from;
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo);
        to.setUTCHours(23, 59, 59, 999);
        if (!isNaN(to.getTime())) dateRange.$lte = to;
      }
      if (Object.keys(dateRange).length > 0) query.createdAt = dateRange;
    }

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate("reporter",   "name email")
        .populate("assignedTo", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-activityLogs -notes")
        .lean(),
      Lead.countDocuments(query),
    ]);

    return { leads, pagination: buildPagination(total, page, limit) };
  }

  // ── Get team member stats ─────────────────────────────────────────────────────
  async getTeamMemberStats(teamId: string) {
    const team = await Team.findById(teamId)
      .populate("members", "name email designation")
      .populate("leaders", "name email designation");

    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const allUsers = [...(team.members as unknown as { _id: { toString(): string }; name: string }[])];

    const stats = await Promise.all(
      allUsers.map(async (u) => {
        const id = u._id.toString();
        const [total, assigned, followup, closed, rejected, cnc, booking, interested] = await Promise.all([
          Lead.countDocuments({ team: teamId, assignedTo: id }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "assigned" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "followup" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "closed" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "rejected" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "cnc" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "booking" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "interested" }),
        ]);
        return { user: u, total, assigned, followup, closed, rejected, cnc, booking, interested };
      })
    );

    return stats;
  }

  // ── Auto-assign team leads to members (within-team distribution) ──────────────
  async autoAssignTeamLeadsToMembers(teamId: string, leadIds?: string[]) {
    const team = await Team.findById(teamId)
      .populate("members", "name")
      .populate("leaders", "_id");
    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    // Exclude team leaders — only regular members receive auto-assigned leads
    const leaderIds = new Set(
      (team.leaders as unknown as { _id: { toString(): string } }[]).map((l) => l._id.toString()),
    );
    const membersList = (team.members as unknown as Array<{ _id: { toString(): string }; name: string }>)
      .filter((m) => !leaderIds.has(m._id.toString()));

    if (membersList.length === 0) {
      throw Object.assign(new Error("This team has no members (excluding leaders) to assign leads to"), { statusCode: 400 });
    }

    // Get leads to assign — either specific leads or all unassigned team leads
    const query = leadIds && leadIds.length > 0
      ? { _id: { $in: leadIds }, team: teamId }
      : { team: teamId, assignedTo: null };

    const leadsToAssign = await Lead.find(query);
    if (leadsToAssign.length === 0) return { assigned: 0, results: [] as { leadId: string; assignedTo: string }[] };

    // Count current loads per member for fair distribution
    const memberLoads = await Promise.all(
      membersList.map(async (m) => ({
        member: m,
        count:  await Lead.countDocuments({ team: teamId, assignedTo: m._id, status: { $in: ["new", "assigned", "followup", "cnc", "booking", "interested"] } }),
      }))
    );
    memberLoads.sort((a, b) => a.count - b.count);

    const results: { leadId: string; assignedTo: string }[] = [];
    const updates: Promise<unknown>[] = [];

    for (let i = 0; i < leadsToAssign.length; i++) {
      const { member } = memberLoads[i % memberLoads.length];
      const lead = leadsToAssign[i];

      updates.push(
        Lead.findByIdAndUpdate(lead._id, {
          $set: { assignedTo: member._id, status: "assigned" },
          $push: {
            activityLogs: {
              action: "lead_assigned",
              description: `Assigned to team member ${member.name}`,
              performedBy: member._id,
              createdAt: new Date(),
            },
          },
        })
      );

      results.push({ leadId: lead._id.toString(), assignedTo: member._id.toString() });
      memberLoads[i % memberLoads.length].count += 1;
    }

    await Promise.all(updates);
    return { assigned: results.length, results };
  }

  // ── Assign lead to a specific member (leaders only) ───────────────────────────
  async assignLeadToMember(
    teamId: string,
    leadId: string,
    memberId: string,
    performedById: string,
  ) {
    const team = await Team.findById(teamId);
    if (!team)
      throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    // Confirm the lead belongs to this team
    const lead = await Lead.findOne({ _id: leadId, team: teamId });
    if (!lead)
      throw Object.assign(new Error("Lead not found in this team"), { statusCode: 404 });

    // Member must be a member of this team
    const isMember = (team.members as unknown as mongoose.Types.ObjectId[]).some(
      (m) => m.toString() === memberId,
    );
    if (!isMember)
      throw Object.assign(new Error("User is not a member of this team"), { statusCode: 400 });

    const user = await User.findById(memberId);
    if (!user)
      throw Object.assign(new Error("User not found"), { statusCode: 404 });

    const prevAssignee = lead.assignedTo?.toString() ?? null;
    lead.assignedTo = user._id;
    lead.status = "assigned";

    lead.activityLogs.push({
      action: "lead_assigned",
      description: `Assigned to ${user.name} by team leader`,
      performedBy: new mongoose.Types.ObjectId(performedById),
      changes: { assignedTo: { from: prevAssignee, to: user._id.toString() } },
      createdAt: new Date(),
    } as never);

    await lead.save();
    return lead;
  }

  // ── Team dashboard stats ───────────────────────────────────────────────────────
  async getTeamDashboard(teamId: string) {
    const team = await Team.findById(teamId)
      .populate("members", "name email designation")
      .populate("leaders", "name email designation");
    if (!team)
      throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const allMembers = [
      ...(team.members as unknown as (IUser & { _id: { toString(): string } })[]),
    ];

    const [total, newCount, assigned, followup, closed, rejected, unassigned, cnc, booking, interested] =
      await Promise.all([
        Lead.countDocuments({ team: teamId }),
        Lead.countDocuments({ team: teamId, status: "new" }),
        Lead.countDocuments({ team: teamId, status: "assigned" }),
        Lead.countDocuments({ team: teamId, status: "followup" }),
        Lead.countDocuments({ team: teamId, status: "closed" }),
        Lead.countDocuments({ team: teamId, status: "rejected" }),
        Lead.countDocuments({ team: teamId, assignedTo: null }),
        Lead.countDocuments({ team: teamId, status: "cnc" }),
        Lead.countDocuments({ team: teamId, status: "booking" }),
        Lead.countDocuments({ team: teamId, status: "interested" }),
      ]);

    const memberRankings = await Promise.all(
      allMembers.map(async (m) => {
        const id = m._id.toString();
        const [mTotal, mAssigned, mFollowup, mClosed, mRejected, mCnc, mBooking, mInterested] = await Promise.all([
          Lead.countDocuments({ team: teamId, assignedTo: id }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "assigned" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "followup" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "closed" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "rejected" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "cnc" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "booking" }),
          Lead.countDocuments({ team: teamId, assignedTo: id, status: "interested" }),
        ]);
        const closureRate = mTotal > 0 ? Math.round((mClosed / mTotal) * 100) : 0;
        const isLeader = (team.leaders as unknown as { _id: { toString(): string } }[]).some(
          (l) => l._id.toString() === id,
        );
        return {
          user: m,
          isLeader,
          total: mTotal,
          assigned: mAssigned,
          followup: mFollowup,
          closed: mClosed,
          rejected: mRejected,
          cnc: mCnc,
          booking: mBooking,
          interested: mInterested,
          closureRate,
        };
      }),
    );

    memberRankings.sort((a, b) => b.closed - a.closed);

    return {
      statusDistribution: { total, new: newCount, assigned, followup, closed, rejected, unassigned, cnc, booking, interested },
      memberRankings,
    };
  }

  // ── Bulk operations within a team ─────────────────────────────────────────────

  /** Bulk-assign multiple team leads to a specific team member */
  async bulkAssignLeadsToMember(
    teamId: string,
    leadIds: string[],
    memberId: string,
    performedById: string,
  ) {
    const team = await Team.findById(teamId);
    if (!team)
      throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const isMember = (team.members as unknown as mongoose.Types.ObjectId[]).some(
      (m) => m.toString() === memberId,
    );
    if (!isMember)
      throw Object.assign(new Error("User is not a member of this team"), { statusCode: 400 });

    const user = await User.findById(memberId);
    if (!user)
      throw Object.assign(new Error("Member not found"), { statusCode: 404 });

    const leads = await Lead.find({ _id: { $in: leadIds }, team: teamId });
    await Promise.all(
      leads.map(async (lead) => {
        const prev = lead.assignedTo?.toString() ?? null;
        lead.assignedTo = user._id;
        lead.status = "assigned";
        lead.activityLogs.push({
          action: "lead_assigned",
          description: `Bulk assigned to ${user.name} by team leader`,
          performedBy: new mongoose.Types.ObjectId(performedById),
          changes: { assignedTo: { from: prev, to: user._id.toString() } },
          createdAt: new Date(),
        } as never);
        return lead.save();
      }),
    );
    return { updated: leads.length };
  }

  /** Bulk-transfer multiple leads to another team (clears member assignment) */
  async bulkTransferLeads(
    leadIds: string[],
    newTeamId: string,
    performedById: string,
  ) {
    const newTeam = await Team.findById(newTeamId);
    if (!newTeam)
      throw Object.assign(new Error("Target team not found"), { statusCode: 404 });

    const leads = await Lead.find({ _id: { $in: leadIds } });
    await Promise.all(
      leads.map(async (lead) => {
        const prevTeam = lead.team?.toString() ?? null;
        lead.team = newTeam._id;
        (lead as unknown as Record<string, unknown>).assignedTo = null;
        lead.status = "new";
        lead.activityLogs.push({
          action: "team_assigned",
          description: `Bulk transferred to team "${newTeam.name}"`,
          performedBy: new mongoose.Types.ObjectId(performedById),
          changes: { team: { from: prevTeam, to: newTeam._id.toString() } },
          createdAt: new Date(),
        } as never);
        return lead.save();
      }),
    );
    return { updated: leads.length };
  }

  /** Bulk-update status for multiple leads within a team */
  async bulkUpdateTeamLeadsStatus(
    teamId: string,
    leadIds: string[],
    status: string,
    performedById: string,
  ) {
    const leads = await Lead.find({ _id: { $in: leadIds }, team: teamId });
    await Promise.all(
      leads.map(async (lead) => {
        const prev = lead.status;
        if (prev === status) return;
        (lead as unknown as Record<string, unknown>).status = status;
        lead.activityLogs.push({
          action: "status_changed",
          description: `Bulk status changed from "${prev}" to "${status}"`,
          performedBy: new mongoose.Types.ObjectId(performedById),
          changes: { status: { from: prev, to: status } },
          createdAt: new Date(),
        } as never);
        return lead.save();
      }),
    );
    return { updated: leads.length };
  }

  // ── Team updates feed (lead activities + team chat messages) ─────────────────
  async getTeamUpdates(
    teamId: string,
    opts: {
      page?:      number;
      limit?:     number;
      dateFrom?:  string;
      dateTo?:    string;
      memberId?:  string;
      search?:    string;
      action?:    string; // "all" | "notes" | "status" | "assignments" | "messages"
    } = {},
  ) {
    const { page = 1, limit = 30, dateFrom, dateTo, memberId, search, action } = opts;
    const teamObjectId = new mongoose.Types.ObjectId(teamId);
    const skip = (page - 1) * limit;

    const team = await Team.findById(teamId);
    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    // ── Build post-union filter conditions ───────────────────────────────────
    const conditions: Record<string, unknown>[] = [];

    // Date range
    if (dateFrom || dateTo) {
      const cr: Record<string, Date> = {};
      if (dateFrom) cr.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        cr.$lte = end;
      }
      conditions.push({ createdAt: cr });
    }

    // Member filter — author for messages, performedBy for activities
    if (memberId) {
      const mid = new mongoose.Types.ObjectId(memberId);
      conditions.push({ $or: [{ "author._id": mid }, { "performedBy._id": mid }] });
    }

    // Action / type filter
    if (action && action !== "all") {
      if (action === "messages") {
        conditions.push({ type: "message" });
      } else if (action === "notes") {
        conditions.push({ action: { $in: ["note_added", "note_updated"] } });
      } else if (action === "status") {
        conditions.push({ action: "status_changed" });
      } else if (action === "assignments") {
        conditions.push({ action: { $in: ["lead_assigned", "team_assigned"] } });
      } else if (action === "created") {
        conditions.push({ action: "lead_created" });
      }
    }

    // Full-text search — note content, lead name, message content, description
    if (search) {
      const re = { $regex: search, $options: "i" };
      conditions.push({
        $or: [
          { content:              re },
          { "changes.note.to":   re },
          { leadName:            re },
          { description:         re },
        ],
      });
    }

    const filterStage = conditions.length > 0 ? [{ $match: { $and: conditions } }] : [];

    // ── Shared base pipeline ─────────────────────────────────────────────────
    const basePipeline: object[] = [
      { $match: { team: teamObjectId } },
      {
        $lookup: {
          from: "users",
          localField: "author",
          foreignField: "_id",
          as: "_authorArr",
          pipeline: [{ $project: { name: 1, email: 1, designation: 1 } }],
        },
      },
      {
        $addFields: {
          type:   "message",
          author: { $arrayElemAt: ["$_authorArr", 0] },
        },
      },
      { $project: { _authorArr: 0 } },
      {
        $unionWith: {
          coll: "leads",
          pipeline: [
            { $match: { team: teamObjectId } },
            { $unwind: "$activityLogs" },
            {
              $lookup: {
                from: "users",
                localField: "activityLogs.performedBy",
                foreignField: "_id",
                as: "_perf",
                pipeline: [{ $project: { name: 1, email: 1, designation: 1 } }],
              },
            },
            {
              $addFields: {
                "activityLogs.type":        "activity",
                "activityLogs.leadId":      "$_id",
                "activityLogs.leadName":    "$name",
                "activityLogs.performedBy": { $arrayElemAt: ["$_perf", 0] },
              },
            },
            { $replaceRoot: { newRoot: "$activityLogs" } },
          ],
        },
      },
      ...filterStage,
    ];

    // ── Count total (reuse same pipeline) ────────────────────────────────────
    const countResult = await TeamMessage.aggregate([
      ...basePipeline,
      { $count: "total" },
    ]);
    const total = (countResult[0]?.total as number) ?? 0;

    // ── Fetch page ───────────────────────────────────────────────────────────
    const items = await TeamMessage.aggregate([
      ...basePipeline,
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);

    return { items, pagination: buildPagination(total, page, limit) };
  }

  // ── Post a team chat message ───────────────────────────────────────────────────
  async postTeamMessage(teamId: string, authorId: string, content: string) {
    const team = await Team.findById(teamId);
    if (!team) throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const msg = await TeamMessage.create({ team: teamId, author: authorId, content });
    const populated = await TeamMessage.findById(msg._id)
      .populate("author", "name email designation")
      .lean();
    return populated;
  }

  // ── Team activity logs (aggregated from all team leads) ───────────────────────
  async getTeamLogs(teamId: string, page = 1, limit = 20) {
    const teamObjectId = new mongoose.Types.ObjectId(teamId);
    const skip = (page - 1) * limit;

    const [logs, countResult] = await Promise.all([
      Lead.aggregate([
        { $match: { team: teamObjectId } },
        { $unwind: "$activityLogs" },
        {
          $lookup: {
            from: "users",
            localField: "activityLogs.performedBy",
            foreignField: "_id",
            as: "_performer",
          },
        },
        {
          $addFields: {
            "activityLogs.leadId":   "$_id",
            "activityLogs.leadName": "$name",
            "activityLogs.performedBy": {
              $cond: {
                if: { $gt: [{ $size: "$_performer" }, 0] },
                then: { $arrayElemAt: ["$_performer", 0] },
                else: "$activityLogs.performedBy",
              },
            },
          },
        },
        { $replaceRoot: { newRoot: "$activityLogs" } },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]),
      Lead.aggregate([
        { $match: { team: teamObjectId } },
        { $project: { count: { $size: "$activityLogs" } } },
        { $group: { _id: null, total: { $sum: "$count" } } },
      ]),
    ]);

    const total: number = (countResult[0]?.total as number) ?? 0;

    return { logs, pagination: buildPagination(total, page, limit) };
  }
}
