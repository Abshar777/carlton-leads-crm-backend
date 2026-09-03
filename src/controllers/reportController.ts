import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { ReportService } from "../services/reportService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import mongoose from "mongoose";
import * as XLSX from "xlsx";

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
          .populate({ path: "team", select: "name leaders", populate: { path: "leaders", select: "name" } })
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

/** GET /api/reports/bookings/export — full dataset as Excel (no pagination) */
export const exportBookingsExcel = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q          = req.query as Record<string, string>;
    const search     = q.search?.trim()     || undefined;
    const teamId     = q.team?.trim()       || undefined;
    const assignedTo = q.assignedTo?.trim() || undefined;
    const dateField  = q.dateField || "bookedAt";
    const sortBy     = q.sortBy   || "bookedAt";
    const sortOrder  = q.sortOrder === "asc" ? 1 : -1;
    const { dateFrom, dateTo } = getDateParams(q);

    const match: Record<string, unknown> = { status: "booking", bookingDetails: { $exists: true } };
    if (teamId)     match.team       = teamId;
    if (assignedTo) match.assignedTo = assignedTo;

    if (dateFrom || dateTo) {
      const dateFilter: Record<string, unknown> = {};
      if (dateFrom) dateFilter.$gte = new Date(dateFrom);
      if (dateTo)   dateFilter.$lte = new Date(dateTo + "T23:59:59.999Z");
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
        { "bookingDetails.clientName":  { $regex: search, $options: "i" } },
        { "bookingDetails.staffName":   { $regex: search, $options: "i" } },
        { "bookingDetails.contactNo":   { $regex: search, $options: "i" } },
        { "bookingDetails.clientEmail": { $regex: search, $options: "i" } },
      ];
    }

    const sortFieldMap: Record<string, string> = {
      bookedAt:  "bookingDetails.bookedAt",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    };
    const sortSpec: Record<string, 1 | -1> = { [sortFieldMap[sortBy] ?? "bookingDetails.bookedAt"]: sortOrder };

    const leads = await Lead.find(match)
      .populate("assignedTo", "name")
      .populate({ path: "team", select: "name leaders", populate: { path: "leaders", select: "name" } })
      .sort(sortSpec)
      .lean();

    // Build Excel rows
    const rows = leads.map((lead, idx) => {
      const bd   = lead.bookingDetails as Record<string, unknown> | undefined;
      const team = lead.team as { name?: string; leaders?: { name?: string }[] } | null;
      const leaderName = team?.leaders?.length
        ? (team.leaders[0] as { name?: string }).name ?? "—"
        : "—";

      const bookingDate = bd?.bookingDate
        ? new Date(bd.bookingDate as string).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
        : "—";

      return {
        "Row No":                idx + 1,
        "Team Leader Name":      leaderName,
        "Staff Name":            (bd?.staffName as string) || "—",
        "Client Name":           (bd?.clientName as string) || (lead.name as string) || "—",
        "Client Contact Number": (bd?.contactNo as string) || (lead.phone as string) || "—",
        "Email":                 (bd?.clientEmail as string) || (lead.email as string) || "—",
        "Booking Date":          bookingDate,
        "Booking Amount":        bd?.amount != null ? bd.amount : "—",
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    // Auto column widths
    ws["!cols"] = [
      { wch: 8 }, { wch: 22 }, { wch: 20 }, { wch: 24 },
      { wch: 20 }, { wch: 28 }, { wch: 16 }, { wch: 16 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Bookings");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `bookings-export-${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
};

const ALL_LEAD_STATUSES = [
  "new","assigned","followup","interested","cnc","booking",
  "notinterested","closed","invalid","rnr","callback","whatsapp","student",
] as const;

/**
 * GET /api/reports/team-member-report?teamId=...
 *
 * Returns per-member breakdown that adapts to the team's tag:
 *  - "booking" tag → booking-specific metrics (this month + old conversions + conversion rate)
 *  - "closing" tag → same but for "closed" status
 *  - any other     → simple all-time per-status counts
 */
export const getTeamMemberReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const teamId = q.teamId?.trim();
    if (!teamId) { sendError(res, "teamId is required", 400); return; }

    // Validate ObjectId format before constructing
    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      sendError(res, "Invalid teamId", 400); return;
    }
    const teamObjId = new mongoose.Types.ObjectId(teamId);

    // Determine report type from team tags
    const team = await Team.findById(teamObjId).populate("tags", "name").lean();
    if (!team) { sendError(res, "Team not found", 404); return; }

    const tagNames: string[] = ((team as any).tags ?? []).map(
      (t: any) => (t.name ?? "").toLowerCase()
    );
    const isBooking = tagNames.some((n) => n === "booking");
    const isClosing = tagNames.some((n) => n === "closing");
    const reportType = isBooking ? "booking" : isClosing ? "closing" : "general";
    const targetStatus = isBooking ? "booking" : isClosing ? "closed" : null;

    // Current real-month boundaries (UTC)
    const now        = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Members of this team
    const members = await User.find({ team: teamObjId })
      .select("_id name email role")
      .populate("role", "roleName")
      .lean();

    // ── GENERAL REPORT ────────────────────────────────────────────────────────
    if (reportType === "general") {
      const agg = await Lead.aggregate([
        { $match: { team: teamObjId } },
        { $group: { _id: { user: "$assignedTo", status: "$status" }, count: { $sum: 1 } } },
      ]);

      type SC = Record<string, number>;
      const memberMap = new Map<string, { member: (typeof members)[0]; counts: SC; total: number }>();
      for (const m of members) {
        const id = (m._id as { toString(): string }).toString();
        const counts: SC = {};
        for (const s of ALL_LEAD_STATUSES) counts[s] = 0;
        memberMap.set(id, { member: m, counts, total: 0 });
      }

      const totals: SC = {};
      for (const s of ALL_LEAD_STATUSES) totals[s] = 0;
      let grandTotal = 0;

      for (const row of agg) {
        const uid = row._id.user?.toString() ?? "";
        const entry = memberMap.get(uid);
        if (entry) {
          entry.counts[row._id.status] = (entry.counts[row._id.status] ?? 0) + row.count;
          entry.total += row.count;
          totals[row._id.status] = (totals[row._id.status] ?? 0) + row.count;
          grandTotal += row.count;
        }
      }

      sendSuccess(res, "Team member report fetched", {
        reportType: "general",
        rows: Array.from(memberMap.values()),
        totals,
        grandTotal,
        statuses: ALL_LEAD_STATUSES,
      });
      return;
    }

    // ── BOOKING / CLOSING REPORT ──────────────────────────────────────────────
    const [facet] = await Lead.aggregate([
      { $match: { team: teamObjId } },
      {
        $facet: {
          // All leads per member (all time)
          total: [
            { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
          ],
          // Leads created this calendar month
          thisMonth: [
            { $match: { createdAt: { $gte: monthStart } } },
            { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
          ],
          // Old leads (created before this month) whose status became target this month
          oldConversions: [
            { $match: { status: targetStatus, createdAt: { $lt: monthStart }, updatedAt: { $gte: monthStart } } },
            { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
          ],
          // All target-status leads updated this month (new + old)
          targetThisMonth: [
            { $match: { status: targetStatus, updatedAt: { $gte: monthStart } } },
            { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
          ],
          // Other statuses all time (exclude target)
          otherStatuses: [
            { $match: { status: { $ne: targetStatus } } },
            { $group: { _id: { user: "$assignedTo", status: "$status" }, count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    function toMap(arr: { _id: unknown; count: number }[]) {
      const m = new Map<string, number>();
      for (const r of arr) m.set(String(r._id ?? ""), r.count);
      return m;
    }

    const totalMap       = toMap(facet.total);
    const thisMonthMap   = toMap(facet.thisMonth);
    const oldConvMap     = toMap(facet.oldConversions);
    const targetMonthMap = toMap(facet.targetThisMonth);

    // Other-status counts per member
    const otherMap = new Map<string, Record<string, number>>();
    for (const r of (facet.otherStatuses as { _id: { user: unknown; status: string }; count: number }[])) {
      const uid = String(r._id.user ?? "");
      if (!otherMap.has(uid)) otherMap.set(uid, {});
      otherMap.get(uid)![r._id.status] = r.count;
    }

    // Totals accumulators
    const totals = {
      total: 0, thisMonth: 0, oldConversions: 0,
      targetThisMonth: 0, conversionRate: 0,
      otherStatuses: {} as Record<string, number>,
    };

    const rows = members.map((m) => {
      const id             = (m._id as { toString(): string }).toString();
      const total          = totalMap.get(id)       ?? 0;
      const thisMonth      = thisMonthMap.get(id)   ?? 0;
      const oldConversions = oldConvMap.get(id)     ?? 0;
      const targetThisMonth= targetMonthMap.get(id) ?? 0;
      const otherCounts    = otherMap.get(id)       ?? {};
      const conversionRate = thisMonth > 0
        ? Math.round((targetThisMonth / thisMonth) * 1000) / 10
        : 0;

      totals.total           += total;
      totals.thisMonth       += thisMonth;
      totals.oldConversions  += oldConversions;
      totals.targetThisMonth += targetThisMonth;
      for (const [s, c] of Object.entries(otherCounts)) {
        totals.otherStatuses[s] = (totals.otherStatuses[s] ?? 0) + c;
      }

      return { member: m, total, thisMonth, oldConversions, targetThisMonth, conversionRate, otherCounts };
    });

    totals.conversionRate = totals.thisMonth > 0
      ? Math.round((totals.targetThisMonth / totals.thisMonth) * 1000) / 10
      : 0;

    sendSuccess(res, "Team member report fetched", {
      reportType,
      targetStatus,
      rows,
      totals,
      monthStart: monthStart.toISOString(),
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
