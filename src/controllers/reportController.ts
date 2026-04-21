import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { ReportService } from "../services/reportService.js";
import { sendSuccess, sendError } from "../utils/response.js";

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
