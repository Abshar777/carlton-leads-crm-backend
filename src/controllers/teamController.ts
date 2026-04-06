import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { TeamService } from "../services/teamService.js";
import { ReportService } from "../services/reportService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { emitTeamUpdate, emitToUser } from "../socket.js";
import { sendPushToUsers } from "../services/pushService.js";
import { Team } from "../models/Team.js";

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
          "rejected",
          "cnc",
          "booking",
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
