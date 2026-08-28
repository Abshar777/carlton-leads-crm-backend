import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { ReportService } from "../services/reportService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { Lead } from "../models/Lead.js";

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
export const getBookingsReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q       = req.query as Record<string, string>;
    const page    = Math.max(1, parseInt(q.page  || "1",  10));
    const limit   = Math.min(50, parseInt(q.limit || "20", 10));
    const skip    = (page - 1) * limit;
    const search  = q.search?.trim() || undefined;
    const teamId  = q.team?.trim()   || undefined;
    const { dateFrom, dateTo } = getDateParams(q);

    const match: Record<string, unknown> = { status: "booking", bookingDetails: { $exists: true } };
    if (teamId) match.team = teamId;
    if (dateFrom || dateTo) {
      const dateFilter: Record<string, unknown> = {};
      if (dateFrom) dateFilter.$gte = new Date(dateFrom);
      if (dateTo)   dateFilter.$lte = new Date(dateTo + "T23:59:59.999Z");
      match["bookingDetails.bookedAt"] = dateFilter;
    }
    if (search) {
      match.$or = [
        { name:  { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { "bookingDetails.batch":      { $regex: search, $options: "i" } },
        { "bookingDetails.staffName":  { $regex: search, $options: "i" } },
        { "bookingDetails.whatsappNo": { $regex: search, $options: "i" } },
      ];
    }

    const [data, total] = await Promise.all([
      Lead.find(match)
        .populate("assignedTo", "name email")
        .populate("team",       "name")
        .populate("course",     "name amount")
        .sort({ "bookingDetails.bookedAt": -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Lead.countDocuments(match),
    ]);

    sendSuccess(res, "Bookings report fetched", {
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
