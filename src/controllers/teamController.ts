import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { TeamService } from "../services/teamService.js";
import { sendError, sendSuccess } from "../utils/response.js";

const teamService = new TeamService();

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
      req.user?.role?.roleName === "Reporter";
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
    const dashboard = await teamService.getTeamDashboard(req.params.id);
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
    sendSuccess(res, "Message posted", msg, 201);
  } catch (err) {
    next(err);
  }
}
