import type { Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import type { AuthenticatedRequest } from "../types/index.js";
import { TeamService } from "../services/teamService.js";
import { ReportService } from "../services/reportService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { emitTeamUpdate, emitToUser } from "../socket.js";
import { sendPushToUsers } from "../services/pushService.js";
import { Team } from "../models/Team.js";
import { Lead } from "../models/Lead.js";

const teamService   = new TeamService();
const reportService = new ReportService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createTeamSchema = z.object({
  name: z.string().min(1, "Team name is required").max(100),
  description: z.string().max(300).optional(),
  leaders: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(300).optional().nullable(),
  leaders: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

const autoAssignTeamSchema = z.object({
  leadIds: z.array(z.string()).optional(),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export async function createTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = createTeamSchema.parse(req.body);
    const team = await teamService.createTeam(data);
    sendSuccess(res, "Team created successfully", team, 201);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/teams/mine
 * Returns the team(s) the authenticated user belongs to
 * (either as a leader or as a member).
 * Returns null if the user isn't in any team.
 */
export async function getMyTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.userId;
    const team = await teamService.getTeamByMember(userId);
    sendSuccess(res, "My team fetched successfully", team ?? null);
  } catch (err) {
    next(err);
  }
}

export async function getTeams(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      status: req.query.status as string | undefined,
      page: req.query.page as string | undefined,
      limit: req.query.limit as string | undefined,
    };
    const isSuperAdmin =
      req.user?.role?.roleName === "Super Admin" ||
      req.user?.role?.roleName === "Reporter" || 
      req.user?.role?.roleName === "Team Leader";
    if (!isSuperAdmin) {
      sendError(res, "You are not authorized to get teams", 403);
      return;
    }
    const result = await teamService.getTeams(filters);
    sendSuccess(
      res,
      "Teams fetched successfully",
      result.teams,
      200,
      result.pagination,
    );
  } catch (err) {
    next(err);
  }
}

export async function getTeamById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const team = await teamService.getTeamById(req.params.id);
    sendSuccess(res, "Team fetched successfully", team);
  } catch (err) {
    next(err);
  }
}

export async function updateTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = updateTeamSchema.parse(req.body);
    const team = await teamService.updateTeam(
      req.params.id,
      data as Parameters<typeof teamService.updateTeam>[1],
    );
    sendSuccess(res, "Team updated successfully", team);
  } catch (err) {
    next(err);
  }
}

export async function deleteTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await teamService.deleteTeam(req.params.id);
    sendSuccess(res, result.message);
  } catch (err) {
    next(err);
  }
}

export async function getTeamLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const filters = {
      status: req.query.status as string | undefined,
      assignedTo: req.query.assignedTo as string | undefined,
      reporter: req.query.reporter as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page as string | undefined,
      limit: req.query.limit as string | undefined,
      unassignedOnly: req.query.unassignedOnly as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      course: req.query.course as string | undefined,
    };
    const result = await teamService.getTeamLeads(req.params.id, filters);
    sendSuccess(
      res,
      "Team leads fetched successfully",
      result.leads,
      200,
      result.pagination,
    );
  } catch (err) {
    next(err);
  }
}

export async function getTeamMemberStats(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const stats = await teamService.getTeamMemberStats(req.params.id);
    sendSuccess(res, "Team member stats fetched successfully", stats);
  } catch (err) {
    next(err);
  }
}

export async function autoAssignTeamLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { leadIds } = autoAssignTeamSchema.parse(req.body);
    const result = await teamService.autoAssignTeamLeadsToMembers(
      req.params.id,
      leadIds,
    );
    sendSuccess(
      res,
      `${result.assigned} lead(s) auto-assigned to team members`,
      result,
    );
  } catch (err) {
    next(err);
  }
}

export async function assignLeadToMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { memberId } = z
      .object({ memberId: z.string().min(1) })
      .parse(req.body);
    const performedById = req.user!.userId;

    // Check performer is a leader of the team or has admin-level permission
    const teamId = req.params.id;
    const leadId = req.params.leadId;

    const result = await teamService.assignLeadToMember(
      teamId,
      leadId,
      memberId,
      performedById,
    );
    sendSuccess(res, "Lead assigned to member successfully", result);
  } catch (err) {
    next(err);
  }
}

// ─── Bulk operations ──────────────────────────────────────────────────────────

const bulkLeadIdsSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, "At least one lead ID required"),
});

export async function bulkAssignTeamLeadsToMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ memberId: z.string().min(1, "Member ID is required") })
      .parse(req.body);
    const result = await teamService.bulkAssignLeadsToMember(
      req.params.id,
      parsed.leadIds,
      parsed.memberId,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) assigned to member`, result);
  } catch (err) {
    next(err);
  }
}

export async function bulkTransferTeamLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ newTeamId: z.string().min(1, "Target team ID is required") })
      .parse(req.body);
    const result = await teamService.bulkTransferLeads(
      parsed.leadIds,
      parsed.newTeamId,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) transferred`, result);
  } catch (err) {
    next(err);
  }
}

export async function bulkUpdateTeamLeadsStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({
        status: z.enum([
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
        ]),
      })
      .parse(req.body);
    const result = await teamService.bulkUpdateTeamLeadsStatus(
      req.params.id,
      parsed.leadIds,
      parsed.status,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) status updated`, result);
  } catch (err) {
    next(err);
  }
}

export async function getTeamDashboard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const q = req.query as Record<string, string>;
    const dashboard = await teamService.getTeamDashboard(
      req.params.id,
      q.dateFrom?.trim() || undefined,
      q.dateTo?.trim()   || undefined,
    );
    sendSuccess(res, "Team dashboard fetched successfully", dashboard);
  } catch (err) {
    next(err);
  }
}

export async function getTeamLogs(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const limit = Math.min(
      50,
      Math.max(1, parseInt((req.query.limit as string) ?? "20", 10)),
    );
    const result = await teamService.getTeamLogs(req.params.id, page, limit);
    sendSuccess(
      res,
      "Team logs fetched successfully",
      result.logs,
      200,
      result.pagination,
    );
  } catch (err) {
    next(err);
  }
}

export async function getTeamUpdates(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const page     = Math.max(1, parseInt((req.query.page  as string) ?? "1",  10));
    const limit    = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "30", 10)));
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo   = req.query.dateTo   as string | undefined;
    const memberId = req.query.memberId as string | undefined;
    const search   = req.query.search   as string | undefined;
    const action   = req.query.action   as string | undefined;
    const result = await teamService.getTeamUpdates(req.params.id, {
      page, limit, dateFrom, dateTo, memberId, search, action,
    });
    sendSuccess(res, "Team updates fetched successfully", result.items, 200, result.pagination);
  } catch (err) {
    next(err);
  }
}

export async function postTeamMessage(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { content } = z.object({ content: z.string().min(1).max(1000) }).parse(req.body);
    const msg = await teamService.postTeamMessage(req.params.id, req.user!.userId, content);

    // Emit real-time event to everyone in the team room
    if (msg) {
      emitTeamUpdate(req.params.id, { ...(msg as object), type: "message" });
    }

    // ── Push + socket notification to all team leaders ─────────────────────────
    const senderId = req.user!.userId;
    const senderName = (msg as unknown as { author?: { name?: string } })?.author?.name ?? "A team member";
    const teamDoc = await Team.findById(req.params.id).select("leaders name").lean();
    if (teamDoc) {
      const leaderIds = (teamDoc.leaders as unknown as { toString(): string }[])
        .map((l) => l.toString())
        .filter((id) => id !== senderId);

      const notifPayload = {
        title: `💬 Team Update — ${teamDoc.name}`,
        body: `${senderName}: ${content.length > 80 ? content.slice(0, 80) + "…" : content}`,
        tag: `team-message-${req.params.id}`,
        url: `/teams/${req.params.id}`,
        data: { type: "team_message", teamId: req.params.id },
      };

      for (const lid of leaderIds) {
        emitToUser(lid, "notification", { ...notifPayload, createdAt: new Date().toISOString() });
      }
      sendPushToUsers(leaderIds, notifPayload).catch(() => null);
    }

    sendSuccess(res, "Message posted", msg, 201);
  } catch (err) {
    next(err);
  }
}

// ─── Toggle team-member active status (for auto-assignment) ───────────────────
export async function toggleMemberActive(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: teamId, memberId } = req.params;
    const mongoose = await import("mongoose");

    const team = await Team.findById(teamId);
    if (!team) return sendError(res, "Team not found", 404);

    // Verify the user is actually a member (or leader) of this team
    const allIds = [
      ...(team.members as unknown as { toString(): string }[]).map((m) => m.toString()),
      ...(team.leaders as unknown as { toString(): string }[]).map((l) => l.toString()),
    ];
    if (!allIds.includes(memberId)) {
      return sendError(res, "User is not a member of this team", 400);
    }

    const inactiveArr = (team.inactiveMembers as unknown as { toString(): string }[]).map((m) => m.toString());
    const isCurrentlyInactive = inactiveArr.includes(memberId);
    const memberObjId = new mongoose.default.Types.ObjectId(memberId);

    if (isCurrentlyInactive) {
      // Activate — remove from inactiveMembers
      await Team.findByIdAndUpdate(teamId, { $pull: { inactiveMembers: memberObjId } });
    } else {
      // Deactivate — add to inactiveMembers
      await Team.findByIdAndUpdate(teamId, { $addToSet: { inactiveMembers: memberObjId } });
    }

    sendSuccess(res, `Member marked as ${isCurrentlyInactive ? "active" : "inactive"} for auto-assignment`, {
      memberId,
      isActive: isCurrentlyInactive, // after toggle: was inactive → now active
    });
  } catch (err) {
    next(err);
  }
}

// ─── Get Team Member By ID ────────────────────────────────────────────────────
export async function getTeamMemberById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId        = req.params.teamId ?? req.params.id;
    const memberId      = req.params.memberId;
    const requesterId   = req.user!.userId;
    const requesterRole = req.user!.role as { isSystemRole?: boolean; roleName?: string };

    const data = await teamService.getTeamMemberById(teamId, memberId, requesterId, requesterRole);
    sendSuccess(res, "Member fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

// ─── Get Team Member Leads (paginated, filterable) ────────────────────────────
export async function getTeamMemberLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId        = req.params.teamId;
    const memberId      = req.params.memberId;
    const requesterId   = req.user!.userId;
    const requesterRole = req.user!.role as { isSystemRole?: boolean; roleName?: string };

    const filters = {
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      page:   req.query.page   as string | undefined,
      limit:  req.query.limit  as string | undefined,
    };

    const result = await teamService.getTeamMemberLeads(
      teamId, memberId, requesterId, requesterRole, filters,
    );
    sendSuccess(res, "Member leads fetched successfully", result.leads, 200, result.pagination);
  } catch (err) {
    next(err);
  }
}

// ─── Team Revenue (scoped to one team) ───────────────────────────────────────

/** GET /api/teams/:id/revenue?dateFrom=&dateTo= */
export async function getTeamRevenue(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId  = req.params.id;
    const q       = req.query as Record<string, string>;
    const dateFrom = q.dateFrom?.trim() || undefined;
    const dateTo   = q.dateTo?.trim()   || undefined;
    const data = await reportService.getTeamRevenue(teamId, dateFrom, dateTo);
    sendSuccess(res, "Team revenue fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

/** GET /api/teams/:id/revenue/timeline?period=daily|weekly|monthly|yearly&dateFrom=&dateTo= */
export async function getTeamRevenueTimeline(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId = req.params.id;
    const q      = req.query as Record<string, string>;
    const period = (q.period || "monthly") as "daily" | "weekly" | "monthly" | "yearly";

    if (!["daily","weekly","monthly","yearly"].includes(period)) {
      sendError(res, "period must be daily, weekly, monthly, or yearly", 400);
      return;
    }

    const dateFrom = q.dateFrom?.trim() || undefined;
    const dateTo   = q.dateTo?.trim()   || undefined;
    const data = await reportService.getTeamRevenueTimeline(teamId, period, dateFrom, dateTo);
    sendSuccess(res, "Team revenue timeline fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

/** GET /api/teams/:id/reminders?memberId=&isDone=&search=&page=&limit= */
export async function getTeamReminders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId = req.params.id;
    const q = req.query as Record<string, string>;
    const data = await teamService.getTeamReminders(
      teamId,
      req.user!.userId,
      req.user!.role as { isSystemRole?: boolean; roleName?: string },
      {
        memberId: q.memberId?.trim() || undefined,
        isDone:   q.isDone?.trim()   || undefined,
        search:   q.search?.trim()   || undefined,
        page:     q.page,
        limit:    q.limit,
      },
    );
    sendSuccess(res, "Team reminders fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

// ─── Team Settings ────────────────────────────────────────────────────────────

const teamSettingsSchema = z.object({
  autoAssign:        z.boolean(),
  splitMode:         z.enum(["round_robin", "equal_load"]),
  includedMembers:   z.array(z.string()).optional(),
});

export async function getTeamSettings(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const team = await Team.findById(req.params.id).select("settings").lean();
    if (!team) return sendError(res, "Team not found", 404);
    sendSuccess(res, "Team settings fetched", team.settings ?? {});
  } catch (err) {
    next(err);
  }
}

export async function updateTeamSettings(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = teamSettingsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);

    const team = await Team.findById(req.params.id);
    if (!team) return sendError(res, "Team not found", 404);

    const { autoAssign, splitMode, includedMembers } = parsed.data;

    await Team.findByIdAndUpdate(req.params.id, {
      $set: {
        "settings.autoAssign":      autoAssign,
        "settings.splitMode":       splitMode,
        "settings.includedMembers": includedMembers ?? [],
        // Reset round-robin index whenever settings are saved
        "settings.roundRobinIndex": 0,
      },
    });

    sendSuccess(res, "Team settings updated", { autoAssign, splitMode, includedMembers: includedMembers ?? [] });
  } catch (err) {
    next(err);
  }
}

// ── Team member report (with date filtering) ──────────────────────────────────

const ALL_STATUSES = [
  "new","assigned","followup","interested","cnc","booking",
  "notinterested","closed","invalid","rnr","callback","whatsapp","student",
] as const;

/**
 * GET /:id/member-report?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 * Returns per-member lead status counts for the given date window.
 * Members with zero leads in the period are still included (all zeroes).
 */
export async function getTeamMemberReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId  = req.params.id;
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };

    if (!mongoose.isValidObjectId(teamId)) {
      sendError(res, "Invalid team id", 400); return;
    }

    // Date range filter on createdAt
    const dateFilter: Record<string, Date> = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom + "T00:00:00.000+05:30");
    if (dateTo)   dateFilter.$lte = new Date(dateTo   + "T23:59:59.999+05:30");

    const matchFilter: Record<string, unknown> = {
      team: new mongoose.Types.ObjectId(teamId),
    };
    if (dateFrom || dateTo) matchFilter.createdAt = dateFilter;

    // Status sum fields for the aggregation
    const statusSums: Record<string, unknown> = {};
    for (const s of ALL_STATUSES) {
      statusSums[s] = { $sum: { $cond: [{ $eq: ["$status", s] }, 1, 0] } };
    }

    const agg = await Lead.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id:   "$assignedTo",
          total: { $sum: 1 },
          ...statusSums,
        },
      },
      {
        $lookup: {
          from:         "users",
          localField:   "_id",
          foreignField: "_id",
          as:           "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id:         0,
          userId:      "$_id",
          name:        { $ifNull: ["$user.name",        "Unassigned"] },
          email:       { $ifNull: ["$user.email",       ""] },
          designation: { $ifNull: ["$user.designation", ""] },
          total:       1,
          ...Object.fromEntries(ALL_STATUSES.map((s) => [s, 1])),
        },
      },
    ]);

    // Build a map of userId → stats so we can fill in zeros for members
    // who had no leads in this period
    const statsMap = new Map<string, (typeof agg)[0]>(
      agg.map((r) => [r.userId?.toString() ?? "", r]),
    );

    const ZERO = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));

    // Load the team to get the full member list
    // members is a flat ObjectId[] — populate directly (NOT "members.user")
    // inactiveMembers is a separate flat ObjectId[] for active/inactive status
    const team = await Team.findById(teamId)
      .populate("members",        "name email designation")
      .populate("inactiveMembers", "_id")
      .lean();

    if (!team) { sendError(res, "Team not found", 404); return; }

    // After populate, each element in members IS the User document
    type PopMember = { _id: mongoose.Types.ObjectId; name: string; email: string; designation?: string };
    type PopInactive = { _id: mongoose.Types.ObjectId };

    // Build a set of inactive userIds for O(1) lookup
    const inactiveSet = new Set<string>(
      (team.inactiveMembers as unknown as PopInactive[]).map((im) => im._id.toString()),
    );

    const result = (team.members as unknown as PopMember[])
      .map((m) => {
        const uid   = m._id?.toString() ?? "";
        const stats = statsMap.get(uid);
        return {
          userId:      uid,
          name:        m.name        ?? "Unknown",
          email:       m.email       ?? "",
          designation: m.designation ?? "",
          isActive:    !inactiveSet.has(uid),
          total:       stats?.total ?? 0,
          ...(stats ? Object.fromEntries(ALL_STATUSES.map((s) => [s, stats[s] ?? 0])) : ZERO),
        };
      })
      .sort((a, b) => b.total - a.total);

    sendSuccess(res, "Team member report fetched", result);
  } catch (err) {
    next(err);
  }
}

// ─── All activity actions tracked ────────────────────────────────────────────
const TRACK_ACTIONS = [
  "lead_created",
  "lead_updated",
  "status_changed",
  "lead_assigned",
  "note_added",
  "call_made",
] as const;

type TrackAction = (typeof TRACK_ACTIONS)[number];

/**
 * GET /:id/tracking?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *
 * Returns per-member activity counts for the given date window.
 * Each column = number of UNIQUE leads the member performed that action on.
 * e.g. if Robert changed status on 3 leads, status_changed = 3 (not 3 × N changes per lead).
 * Members with zero activity in the period are still included (all zeroes).
 */
export async function getTeamTracking(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId  = req.params.id;
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };

    if (!mongoose.isValidObjectId(teamId)) {
      sendError(res, "Invalid team id", 400); return;
    }

    // IST-aware date range on activityLogs.createdAt
    const logDateFilter: Record<string, Date> = {};
    if (dateFrom) logDateFilter.$gte = new Date(dateFrom + "T00:00:00.000+05:30");
    if (dateTo)   logDateFilter.$lte = new Date(dateTo   + "T23:59:59.999+05:30");

    const teamObjId = new mongoose.Types.ObjectId(teamId);

    const basePipeline = [
      { $match: { team: teamObjId } },
      { $unwind: "$activityLogs" },
      ...(Object.keys(logDateFilter).length
        ? [{ $match: { "activityLogs.createdAt": logDateFilter } }]
        : []),
    ] as mongoose.PipelineStage[];

    // ── Agg 1: total unique leads touched per user ─────────────────────────────
    const totalAgg = await Lead.aggregate([
      ...basePipeline,
      { $group: { _id: { user: "$activityLogs.performedBy", lead: "$_id" } } },
      { $group: { _id: "$_id.user", total: { $sum: 1 } } },
    ]);

    // ── Agg 2: unique leads per (user, action) ─────────────────────────────────
    const actionAgg = await Lead.aggregate([
      ...basePipeline,
      // Dedupe (user, lead, action) — if same action on same lead multiple times → count once
      { $group: { _id: { user: "$activityLogs.performedBy", lead: "$_id", action: "$activityLogs.action" } } },
      { $group: { _id: { user: "$_id.user", action: "$_id.action" }, count: { $sum: 1 } } },
      { $group: { _id: "$_id.user", actions: { $push: { action: "$_id.action", count: "$count" } } } },
    ]);

    // ── Agg 3: unique leads per (user, status changed TO) ──────────────────────
    // Uses changes.status.to from status_changed log entries.
    // Counts unique leads — if user changed same lead to "followup" twice → 1, not 2.
    const statusAgg = await Lead.aggregate([
      ...basePipeline,
      { $match: { "activityLogs.action": "status_changed" } },
      // Dedupe (user, lead, status_to) — same lead changed to same status multiple times → 1
      {
        $group: {
          _id: {
            user:     "$activityLogs.performedBy",
            lead:     "$_id",
            statusTo: "$activityLogs.changes.status.to",
          },
        },
      },
      { $group: { _id: { user: "$_id.user", statusTo: "$_id.statusTo" }, count: { $sum: 1 } } },
      { $group: { _id: "$_id.user", statuses: { $push: { status: "$_id.statusTo", count: "$count" } } } },
    ]);

    // Build lookup maps
    const totalMap = new Map<string, number>(
      totalAgg.map((r) => [r._id?.toString() ?? "", r.total as number]),
    );
    const actionMap = new Map<string, { action: string; count: number }[]>(
      actionAgg.map((r) => [r._id?.toString() ?? "", r.actions as { action: string; count: number }[]]),
    );
    const statusMap = new Map<string, { status: string; count: number }[]>(
      statusAgg.map((r) => [r._id?.toString() ?? "", r.statuses as { status: string; count: number }[]]),
    );

    // Load team members (flat ObjectId[] — same pattern as member-report)
    const team = await Team.findById(teamId)
      .populate("members",        "name email designation")
      .populate("inactiveMembers", "_id")
      .lean();

    if (!team) { sendError(res, "Team not found", 404); return; }

    type PopMember   = { _id: mongoose.Types.ObjectId; name: string; email: string; designation?: string };
    type PopInactive = { _id: mongoose.Types.ObjectId };

    const inactiveSet = new Set<string>(
      (team.inactiveMembers as unknown as PopInactive[]).map((im) => im._id.toString()),
    );

    const ZERO_ACTIONS  = Object.fromEntries(TRACK_ACTIONS.map((a) => [a, 0]));
    const ZERO_STATUSES = Object.fromEntries(ALL_STATUSES.map((s) => [`status_to_${s}`, 0]));

    const result = (team.members as unknown as PopMember[])
      .map((m) => {
        const uid      = m._id?.toString() ?? "";
        const actions  = actionMap.get(uid) ?? [];
        const statuses = statusMap.get(uid) ?? [];

        const actionObj = {
          ...ZERO_ACTIONS,
          ...Object.fromEntries(actions.map((a) => [a.action, a.count])),
        };
        // Prefix status keys with "status_to_" to avoid collisions with action keys
        const statusObj = {
          ...ZERO_STATUSES,
          ...Object.fromEntries(
            statuses
              .filter((s) => s.status) // skip nulls from old logs without changes field
              .map((s) => [`status_to_${s.status}`, s.count]),
          ),
        };

        return {
          userId:      uid,
          name:        m.name        ?? "Unknown",
          email:       m.email       ?? "",
          designation: m.designation ?? "",
          isActive:    !inactiveSet.has(uid),
          total:       totalMap.get(uid) ?? 0,
          ...actionObj,
          ...statusObj,
        };
      })
      .sort((a, b) => b.total - a.total);

    sendSuccess(res, "Team tracking fetched", result);
  } catch (err) {
    next(err);
  }
}
