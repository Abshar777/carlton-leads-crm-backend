import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { ReportService } from "../services/reportService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";

const svc = new ReportService();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDateParams(query: Record<string, string>) {
  const dateFrom = query.dateFrom?.trim() || undefined;
  const dateTo   = query.dateTo?.trim()   || undefined;
  return { dateFrom, dateTo };
}

// ── Controllers ───────────────────────────────────────────────────────────────

/** GET /api/reports/overview?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD */
export const getOverview = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getOverview(dateFrom, dateTo);
    sendSuccess(res, "Overview fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/timeline
 * ?period=daily|weekly|monthly&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 */
export const getTimeline = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const period = (q.period || "daily") as "daily" | "weekly" | "monthly";

    if (!["daily", "weekly", "monthly"].includes(period)) {
      sendError(res, "period must be daily, weekly, or monthly", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getTimeline(period, dateFrom, dateTo);
    sendSuccess(res, "Timeline fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/users?dateFrom=...&dateTo=...&limit=20 */
export const getUserRankings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q     = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q.limit || "20", 10), 50);
    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getUserRankings(dateFrom, dateTo, limit);
    sendSuccess(res, "User rankings fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/team-split
 * ?period=daily|weekly|monthly|yearly&dateFrom=...&dateTo=...
 */
export const getTeamSplit = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const period = (q.period || "monthly") as "daily" | "weekly" | "monthly" | "yearly";

    if (!["daily","weekly","monthly","yearly"].includes(period)) {
      sendError(res, "period must be daily, weekly, monthly, or yearly", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getTeamSplit(period, dateFrom, dateTo);
    sendSuccess(res, "Team split fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/teams?dateFrom=...&dateTo=... */
export const getTeamRankings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getTeamRankings(dateFrom, dateTo);
    sendSuccess(res, "Team rankings fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

// ── Revenue controllers ───────────────────────────────────────────────────────

/** GET /api/reports/revenue/overview?dateFrom=&dateTo= */
export const getRevenueOverview = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getRevenueOverview(dateFrom, dateTo);
    sendSuccess(res, "Revenue overview fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/revenue/timeline
 * ?period=daily|weekly|monthly|yearly&dateFrom=&dateTo=
 */
export const getRevenueTimeline = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const period = (q.period || "monthly") as "daily" | "weekly" | "monthly" | "yearly";

    if (!["daily","weekly","monthly","yearly"].includes(period)) {
      sendError(res, "period must be daily, weekly, monthly, or yearly", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getRevenueTimeline(period, dateFrom, dateTo);
    sendSuccess(res, "Revenue timeline fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/sources?dateFrom=&dateTo=&team= */
export const getSourceAnalytics = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.team?.trim() || undefined;
    const data = await svc.getSourceAnalytics(dateFrom, dateTo, teamId);
    sendSuccess(res, "Source analytics fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/sources/:source/campaigns?dateFrom=&dateTo= */
export const getSourceCampaigns = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const source = req.params.source?.trim();
    if (!source) {
      sendError(res, "source param is required", 400);
      return;
    }
    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getSourceCampaigns(source, dateFrom, dateTo);
    sendSuccess(res, "Campaign breakdown fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/bookings?dateFrom=&dateTo=&page=&limit=&search=&team= */
function buildStatusReport(status: string, defaultDateField: string) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const q          = req.query as Record<string, string>;
      const page       = Math.max(1, parseInt(q.page  || "1",  10));
      const limit      = Math.min(100, parseInt(q.limit || "20", 10));
      const skip       = (page - 1) * limit;
      const search     = q.search?.trim()    || undefined;
      const teamId     = q.team?.trim()      || undefined;
      const assignedTo = q.assignedTo?.trim()|| undefined;
      // sortBy: which date field to sort on — bookedAt | closedAt | createdAt | updatedAt
      const sortBy     = q.sortBy  || defaultDateField;
      const sortOrder  = q.sortOrder === "asc" ? 1 : -1;
      // dateField: which date field the dateFrom/dateTo range applies to
      const dateField  = q.dateField || defaultDateField;
      const { dateFrom, dateTo } = getDateParams(q);

      const match: Record<string, unknown> = { status };
      if (status === "booking") match.bookingDetails = { $exists: true };
      if (teamId)     match.team       = teamId;
      if (assignedTo) match.assignedTo = assignedTo;

      if (dateFrom || dateTo) {
        const dateFilter: Record<string, unknown> = {};
        if (dateFrom) dateFilter.$gte = new Date(dateFrom);
        if (dateTo)   dateFilter.$lte = new Date(dateTo + "T23:59:59.999Z");
        // Map friendly names to actual Mongo field paths
        const fieldMap: Record<string, string> = {
          bookedAt:  "bookingDetails.bookedAt",
          createdAt: "createdAt",
          updatedAt: "updatedAt",
        };
        match[fieldMap[dateField] ?? dateField] = dateFilter;
      }

      if (search) {
        match.$or = [
          { name:  { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { "bookingDetails.clientName":  { $regex: search, $options: "i" } },
          { "bookingDetails.batch":       { $regex: search, $options: "i" } },
          { "bookingDetails.staffName":   { $regex: search, $options: "i" } },
          { "bookingDetails.whatsappNo":  { $regex: search, $options: "i" } },
          { "bookingDetails.contactNo":   { $regex: search, $options: "i" } },
          { "bookingDetails.clientEmail": { $regex: search, $options: "i" } },
        ];
      }

      const sortFieldMap: Record<string, string> = {
        bookedAt:  "bookingDetails.bookedAt",
        createdAt: "createdAt",
        updatedAt: "updatedAt",
      };
      const sortField = sortFieldMap[sortBy] ?? "createdAt";
      const sortSpec: Record<string, 1 | -1> = { [sortField]: sortOrder };

      const [data, total] = await Promise.all([
        Lead.find(match)
          .populate("assignedTo", "name email")
          .populate("team",       "name")
          .populate("course",     "name amount")
          .sort(sortSpec)
          .skip(skip)
          .limit(limit)
          .lean(),
        Lead.countDocuments(match),
      ]);

      sendSuccess(res, `${status} report fetched`, {
        data,
        pagination: {
          total, page, limit,
          totalPages:  Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

export const getBookingsReport = buildStatusReport("booking", "bookedAt");
export const getClosingsReport = buildStatusReport("closed",  "updatedAt");

const ALL_LEAD_STATUSES = [
  "new","assigned","followup","interested","cnc","booking",
  "notinterested","closed","invalid","rnr","callback","whatsapp","student",
] as const;

/**
 * GET /api/reports/team-member-report
 * ?teamId=...&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *
 * Returns per-member lead status breakdown for a team.
 */
export const getTeamMemberReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const teamId = q.teamId?.trim();
    if (!teamId) {
      sendError(res, "teamId is required", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);

    const dateFilter: Record<string, unknown> = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo)   dateFilter.$lte = new Date(dateTo + "T23:59:59.999Z");

    const matchBase: Record<string, unknown> = { team: teamId };
    if (dateFrom || dateTo) matchBase.createdAt = dateFilter;

    // Aggregate: group by assignedTo + status → counts
    const agg = await Lead.aggregate([
      { $match: matchBase },
      {
        $group: {
          _id:    { user: "$assignedTo", status: "$status" },
          count:  { $sum: 1 },
        },
      },
    ]);

    // Get all members of this team (to include members with 0 leads)
    const members = await User.find({ team: teamId })
      .select("_id name email role")
      .populate("role", "roleName")
      .lean();

    // Build member map
    type StatusCounts = Record<string, number>;
    const memberMap = new Map<string, { member: typeof members[0]; counts: StatusCounts; total: number }>();

    for (const m of members) {
      const id = (m._id as { toString(): string }).toString();
      const counts: StatusCounts = {};
      for (const s of ALL_LEAD_STATUSES) counts[s] = 0;
      memberMap.set(id, { member: m, counts, total: 0 });
    }

    // Fill in lead counts (also catch leads assigned to users no longer in team)
    const unknownUsers = new Map<string, StatusCounts & { total: number }>();
    for (const row of agg) {
      const userId  = row._id.user?.toString() ?? "unassigned";
      const status  = row._id.status as string;
      const count   = row.count as number;

      if (memberMap.has(userId)) {
        const entry = memberMap.get(userId)!;
        entry.counts[status] = (entry.counts[status] ?? 0) + count;
        entry.total += count;
      } else {
        if (!unknownUsers.has(userId)) {
          const c: StatusCounts & { total: number } = { total: 0 };
          for (const s of ALL_LEAD_STATUSES) c[s] = 0;
          unknownUsers.set(userId, c);
        }
        const u = unknownUsers.get(userId)!;
        u[status] = (u[status] ?? 0) + count;
        u.total += count;
      }
    }

    // Totals row
    const totals: StatusCounts = {};
    for (const s of ALL_LEAD_STATUSES) totals[s] = 0;
    let grandTotal = 0;

    const rows = Array.from(memberMap.values()).map(({ member, counts, total }) => {
      for (const s of ALL_LEAD_STATUSES) totals[s] = (totals[s] ?? 0) + (counts[s] ?? 0);
      grandTotal += total;
      return { member, counts, total };
    });

    sendSuccess(res, "Team member report fetched", {
      rows,
      totals,
      grandTotal,
      statuses: ALL_LEAD_STATUSES,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/revenue/teams?dateFrom=&dateTo= */
export const getRevenueTeams = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getRevenueTeams(dateFrom, dateTo);
    sendSuccess(res, "Revenue teams fetched successfully", data);
  } catch (err) {
    next(err);
  }
};
