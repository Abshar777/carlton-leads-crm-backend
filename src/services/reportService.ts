import mongoose from "mongoose";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";

const ALL_STATUSES = [
  "new", "assigned", "followup", "interested", "cnc", "booking", "partialbooking", "closed", "rejected",
] as const;

type LeadStatus = (typeof ALL_STATUSES)[number];

interface DateFilter {
  createdAt?: { $gte?: Date; $lte?: Date };
}

export class ReportService {
  // ── Date helpers ────────────────────────────────────────────────────────────

  private buildDateFilter(dateFrom?: string, dateTo?: string): DateFilter {
    if (!dateFrom && !dateTo) return {};
    const f: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) f.$gte = new Date(dateFrom + "T00:00:00.000Z");
    if (dateTo)   f.$lte = new Date(dateTo   + "T23:59:59.999Z");
    return { createdAt: f };
  }

  // Build per-status $sum expressions for $group stage
  private statusSumFields() {
    return ALL_STATUSES.reduce<Record<string, unknown>>((acc, s) => {
      acc[s] = { $sum: { $cond: [{ $eq: ["$status", s] }, 1, 0] } };
      return acc;
    }, {});
  }

  // ── 1. Overview KPIs + status & source distributions ────────────────────────

  async getOverview(dateFrom?: string, dateTo?: string) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // Status distribution
    const statusAgg = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const statusMap: Record<string, number> = {};
    ALL_STATUSES.forEach((s) => (statusMap[s] = 0));
    let total = 0;
    for (const item of statusAgg) {
      statusMap[item._id] = item.count;
      total += item.count;
    }

    // Source distribution
    const sourceAgg = await Lead.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ["$source", "other"] }, count: { $sum: 1 } } },
    ]);

    const sourceDist = sourceAgg
      .map((i) => ({ source: (i._id as string) || "other", count: i.count as number }))
      .sort((a, b) => b.count - a.count);

    // Team & user counts
    const [activeTeams, totalTeams, activeUsers] = await Promise.all([
      Team.countDocuments({ status: "active" }),
      Team.countDocuments(),
      User.countDocuments({ status: "active" }),
    ]);

    const conversionRate =
      total > 0 ? +((statusMap.closed / total) * 100).toFixed(1) : 0;

    return {
      summary: {
        total,
        closed: statusMap.closed,
        conversionRate,
        activeTeams,
        totalTeams,
        activeUsers,
      },
      statusDistribution: ALL_STATUSES.map((s) => ({
        status: s,
        count:  statusMap[s],
        pct:    total > 0 ? +((statusMap[s] / total) * 100).toFixed(1) : 0,
      })),
      sourceDistribution: sourceDist,
    };
  }

  // ── 2. Lead timeline (daily / weekly / monthly) ──────────────────────────────

  async getTimeline(
    period: "daily" | "weekly" | "monthly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let groupId: any;
    if (period === "daily") {
      groupId = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    } else if (period === "weekly") {
      groupId = {
        year: { $isoWeekYear: "$createdAt" },
        week: { $isoWeek: "$createdAt" },
      };
    } else {
      groupId = {
        year:  { $year:  "$createdAt" },
        month: { $month: "$createdAt" },
      };
    }

    const agg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id:   groupId,
          total: { $sum: 1 },
          ...this.statusSumFields(),
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    return agg.map((item) => {
      let label: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = item._id as any;

      if (typeof id === "string") {
        label = id; // YYYY-MM-DD
      } else if (id?.week !== undefined) {
        label = `W${id.week} '${String(id.year).slice(2)}`;
      } else {
        label = `${MONTHS[id.month]} '${String(id.year).slice(2)}`;
      }

      const row: Record<string, number | string> = { label, total: item.total as number };
      ALL_STATUSES.forEach((s) => { row[s] = item[s] as number ?? 0; });
      return row;
    });
  }

  // ── 3. User rankings ─────────────────────────────────────────────────────────

  async getUserRankings(dateFrom?: string, dateTo?: string, limit = 20) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    const agg = await Lead.aggregate([
      { $match: { ...match, assignedTo: { $exists: true, $ne: null } } },
      {
        $group: {
          _id:   "$assignedTo",
          total: { $sum: 1 },
          ...this.statusSumFields(),
        },
      },
      { $sort: { closed: -1, total: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from:         "users",
          localField:   "_id",
          foreignField: "_id",
          as:           "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: false } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        $project: {
          userId:      "$_id",
          name:        "$user.name",
          email:       "$user.email",
          designation: "$user.designation",
          total:       1,
          new: 1, assigned: 1, followup: 1, interested: 1,
          cnc: 1, booking: 1, closed: 1, rejected: 1,
          conversionRate: {
            $cond: [
              { $gt: ["$total", 0] },
              { $round: [{ $multiply: [{ $divide: ["$closed", "$total"] }, 100] }, 1] },
              0,
            ],
          },
        } as Record<string, unknown>,
      },
    ]);

    return agg.map((item, i) => ({ ...item, rank: i + 1 }));
  }

  // ── 4. Team rankings ─────────────────────────────────────────────────────────

  async getTeamRankings(dateFrom?: string, dateTo?: string) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    const agg = await Lead.aggregate([
      { $match: { ...match, team: { $exists: true, $ne: null } } },
      {
        $group: {
          _id:           "$team",
          total:         { $sum: 1 },
          // Sum all payments[].amount across every lead in this team
          totalPayments: { $sum: { $sum: "$payments.amount" } },
          ...this.statusSumFields(),
        },
      },
      // Rank by highest total payments collected
      { $sort: { totalPayments: -1, total: -1 } },
      {
        $lookup: {
          from:         "teams",
          localField:   "_id",
          foreignField: "_id",
          as:           "team",
        },
      },
      { $unwind: { path: "$team", preserveNullAndEmptyArrays: false } },
      {
        $project: {
          teamId:        "$_id",
          name:          "$team.name",
          description:   "$team.description",
          memberCount:   { $size: { $ifNull: ["$team.members", []] } },
          total:         1,
          totalPayments: 1,
          new: 1, assigned: 1, followup: 1, interested: 1,
          cnc: 1, booking: 1, partialbooking: 1, closed: 1, rejected: 1,
          conversionRate: {
            $cond: [
              { $gt: ["$total", 0] },
              { $round: [{ $multiply: [{ $divide: ["$closed", "$total"] }, 100] }, 1] },
              0,
            ],
          },
        } as Record<string, unknown>,
      },
    ]);

    return agg.map((item, i) => ({ ...item, rank: i + 1 }));
  }

  // ── 5. Team lead split over time ─────────────────────────────────────────────

  async getTeamSplit(
    period: "daily" | "weekly" | "monthly" | "yearly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bucketId: any;
    if (period === "daily") {
      bucketId = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    } else if (period === "weekly") {
      bucketId = { year: { $isoWeekYear: "$createdAt" }, week: { $isoWeek: "$createdAt" } };
    } else if (period === "monthly") {
      bucketId = { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } };
    } else {
      bucketId = { year: { $year: "$createdAt" } };
    }

    // Aggregate: per (time-bucket, team) → count + status breakdown
    const agg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id:   { bucket: bucketId, team: "$team" },
          count: { $sum: 1 },
          ...this.statusSumFields(),
        },
      },
      { $sort: { "_id.bucket": 1 } },
      {
        $lookup: {
          from:         "teams",
          localField:   "_id.team",
          foreignField: "_id",
          as:           "teamInfo",
        },
      },
      { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bucket:   "$_id.bucket",
          teamId:   "$_id.team",
          teamName: { $ifNull: ["$teamInfo.name", "Unassigned"] },
          count:    1,
          new: 1, assigned: 1, followup: 1, interested: 1,
          cnc: 1, booking: 1, closed: 1, rejected: 1,
        } as Record<string, unknown>,
      },
    ]);

    // Collect all unique team names (for chart series)
    const teamSet = new Map<string, string>(); // teamId → teamName
    for (const row of agg) {
      const tid = row.teamId ? String(row.teamId) : "unassigned";
      teamSet.set(tid, row.teamName as string);
    }

    // Build per-bucket totals
    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucketMap = new Map<string, Record<string, any>>();

    for (const row of agg) {
      // Determine label from bucket
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = row.bucket as any;
      let label: string;
      if (typeof b === "string") {
        label = b;
      } else if (b?.week !== undefined) {
        label = `W${b.week} '${String(b.year).slice(2)}`;
      } else if (b?.month !== undefined) {
        label = `${MONTHS[b.month as number]} '${String(b.year).slice(2)}`;
      } else {
        label = String(b?.year ?? "—");
      }

      if (!bucketMap.has(label)) {
        bucketMap.set(label, { label, total: 0 });
      }

      const bucket = bucketMap.get(label)!;
      const tid    = row.teamId ? String(row.teamId) : "unassigned";
      const tname  = row.teamName as string;

      bucket[tname] = (bucket[tname] ?? 0) + (row.count as number);
      bucket.total  = (bucket.total  ?? 0) + (row.count as number);

      // also accumulate status breakdown per team
      const statusKey = `${tname}__status`;
      if (!bucket[statusKey]) {
        bucket[statusKey] = { new: 0, assigned: 0, followup: 0, interested: 0, cnc: 0, booking: 0, closed: 0, rejected: 0 };
      }
      ALL_STATUSES.forEach((s) => {
        bucket[statusKey][s] = (bucket[statusKey][s] ?? 0) + ((row[s] as number) ?? 0);
      });
    }

    // Team summary totals (across all periods)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teamTotals = new Map<string, Record<string, any>>();
    for (const row of agg) {
      const tname = row.teamName as string;
      if (!teamTotals.has(tname)) {
        teamTotals.set(tname, { teamName: tname, total: 0, closed: 0, ...Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) });
      }
      const t = teamTotals.get(tname)!;
      t.total += row.count as number;
      ALL_STATUSES.forEach((s) => { t[s] += (row[s] as number) ?? 0; });
    }

    const teams = Array.from(teamSet.values());
    const timeline = Array.from(bucketMap.values());
    const summary  = Array.from(teamTotals.values()).sort((a, b) => b.total - a.total).map((t, i) => ({
      ...t,
      rank: i + 1,
      conversionRate: t.total > 0 ? +((t.closed / t.total) * 100).toFixed(1) : 0,
    }));

    return { teams, timeline, summary };
  }

  // ── Revenue helpers ──────────────────────────────────────────────────────────

  /** Build a match filter on payments.paidAt (used after $unwind: "$payments") */
  private buildPaymentDateFilter(dateFrom?: string, dateTo?: string): Record<string, unknown> {
    if (!dateFrom && !dateTo) return {};
    const f: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) f.$gte = new Date(dateFrom + "T00:00:00.000Z");
    if (dateTo)   f.$lte = new Date(dateTo   + "T23:59:59.999Z");
    return { "payments.paidAt": f };
  }

  // ── 6. Revenue overview ───────────────────────────────────────────────────────

  async getRevenueOverview(dateFrom?: string, dateTo?: string) {
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    const [summaryAgg, teamAgg, agentAgg] = await Promise.all([
      // ── total revenue / payment count / paying leads
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: paymentMatch },
        {
          $group: {
            _id:          null,
            totalRevenue: { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
      ]),

      // ── top teams by revenue
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: paymentMatch },
        {
          $group: {
            _id:          "$team",
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "teams", localField: "_id", foreignField: "_id", as: "teamInfo",
          },
        },
        { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            teamId:       "$_id",
            name:         { $ifNull: ["$teamInfo.name", "Unassigned"] },
            revenue:      1,
            paymentCount: 1,
          },
        },
      ]),

      // ── top agents by revenue (attributed to lead's assignedTo)
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: paymentMatch },
        {
          $group: {
            _id:          "$assignedTo",
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 15 },
        {
          $lookup: {
            from: "users", localField: "_id", foreignField: "_id", as: "userInfo",
          },
        },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: false } },
        {
          $project: {
            userId:       "$_id",
            name:         "$userInfo.name",
            email:        "$userInfo.email",
            designation:  "$userInfo.designation",
            revenue:      1,
            paymentCount: 1,
          },
        },
      ]),
    ]);

    const summary        = summaryAgg[0] ?? { totalRevenue: 0, paymentCount: 0, leadIds: [] };
    const totalRevenue   = summary.totalRevenue   as number ?? 0;
    const paymentCount   = summary.paymentCount   as number ?? 0;
    const payingLeadCount = (summary.leadIds as unknown[])?.length ?? 0;
    const avgRevenuePerLead = payingLeadCount > 0
      ? +((totalRevenue / payingLeadCount).toFixed(2))
      : 0;

    const topTeam  = teamAgg[0]  ? { name: teamAgg[0].name  as string, revenue: teamAgg[0].revenue  as number } : null;
    const topAgent = agentAgg[0] ? { name: agentAgg[0].name as string, revenue: agentAgg[0].revenue as number, designation: agentAgg[0].designation as string | undefined } : null;

    return {
      totalRevenue,
      payingLeadCount,
      paymentCount,
      avgRevenuePerLead,
      topTeam,
      topAgent,
      teamBreakdown:  teamAgg.map((t, i)  => ({ ...t, rank: i + 1 })),
      agentBreakdown: agentAgg.map((a, i) => ({ ...a, rank: i + 1 })),
    };
  }

  // ── 7. Revenue timeline (per team, per time bucket) ───────────────────────────

  async getRevenueTimeline(
    period: "daily" | "weekly" | "monthly" | "yearly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bucketId: any;
    if (period === "daily") {
      bucketId = { $dateToString: { format: "%Y-%m-%d", date: "$payments.paidAt" } };
    } else if (period === "weekly") {
      bucketId = { year: { $isoWeekYear: "$payments.paidAt" }, week: { $isoWeek: "$payments.paidAt" } };
    } else if (period === "monthly") {
      bucketId = { year: { $year: "$payments.paidAt" }, month: { $month: "$payments.paidAt" } };
    } else {
      bucketId = { year: { $year: "$payments.paidAt" } };
    }

    const agg = await Lead.aggregate([
      { $unwind: "$payments" },
      { $match: paymentMatch },
      {
        $group: {
          _id:     { bucket: bucketId, team: "$team" },
          revenue: { $sum: "$payments.amount" },
        },
      },
      { $sort: { "_id.bucket": 1 } },
      {
        $lookup: {
          from: "teams", localField: "_id.team", foreignField: "_id", as: "teamInfo",
        },
      },
      { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bucket:   "$_id.bucket",
          teamName: { $ifNull: ["$teamInfo.name", "Unassigned"] },
          revenue:  1,
        },
      },
    ]);

    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const teamSet   = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucketMap = new Map<string, Record<string, any>>();

    for (const row of agg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = row.bucket as any;
      let label: string;
      if (typeof b === "string") {
        label = b;
      } else if (b?.week !== undefined) {
        label = `W${b.week as number} '${String(b.year as number).slice(2)}`;
      } else if (b?.month !== undefined) {
        label = `${MONTHS[b.month as number]} '${String(b.year as number).slice(2)}`;
      } else {
        label = String(b?.year ?? "—");
      }

      const teamName = row.teamName as string;
      teamSet.add(teamName);

      if (!bucketMap.has(label)) bucketMap.set(label, { label, total: 0 });
      const bucket = bucketMap.get(label)!;
      bucket[teamName] = ((bucket[teamName] as number) ?? 0) + (row.revenue as number);
      bucket.total     = ((bucket.total    as number) ?? 0) + (row.revenue as number);
    }

    return {
      teams:    Array.from(teamSet),
      timeline: Array.from(bucketMap.values()),
    };
  }

  // ── 8. Revenue teams with member breakdown ───────────────────────────────────

  async getRevenueTeams(dateFrom?: string, dateTo?: string) {
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    const agg = await Lead.aggregate([
      { $unwind: "$payments" },
      { $match: paymentMatch },
      // ① group by (team × member)
      {
        $group: {
          _id:          { team: "$team", member: "$assignedTo" },
          revenue:      { $sum: "$payments.amount" },
          paymentCount: { $sum: 1 },
          leadIds:      { $addToSet: "$_id" },
        },
      },
      // ② look up user info for each member
      {
        $lookup: {
          from: "users", localField: "_id.member", foreignField: "_id", as: "userInfo",
        },
      },
      { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
      // ③ group by team to collect member array
      {
        $group: {
          _id:              "$_id.team",
          teamRevenue:      { $sum: "$revenue" },
          teamPaymentCount: { $sum: "$paymentCount" },
          teamLeadCount:    { $sum: { $size: "$leadIds" } },
          members: {
            $push: {
              userId:       "$_id.member",
              name:         { $ifNull: ["$userInfo.name", "Unassigned"] },
              designation:  "$userInfo.designation",
              revenue:      "$revenue",
              paymentCount: "$paymentCount",
              leadCount:    { $size: "$leadIds" },
            },
          },
        },
      },
      { $sort: { teamRevenue: -1 } },
      // ④ look up team info
      {
        $lookup: {
          from: "teams", localField: "_id", foreignField: "_id", as: "teamInfo",
        },
      },
      { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          teamId:       "$_id",
          name:         { $ifNull: ["$teamInfo.name", "Unassigned"] },
          revenue:      "$teamRevenue",
          paymentCount: "$teamPaymentCount",
          leadCount:    "$teamLeadCount",
          members:      1,
        },
      },
    ]);

    // Sort members desc + add pct of team revenue
    return agg.map((team, i) => ({
      ...team,
      rank: i + 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      members: (team.members as any[])
        .sort((a, b) => (b.revenue as number) - (a.revenue as number))
        .map((m) => ({
          ...m,
          pct: (team.revenue as number) > 0
            ? +(((m.revenue as number) / (team.revenue as number)) * 100).toFixed(1)
            : 0,
        })),
    }));
  }

  // ── 9. Team-scoped revenue overview (KPIs + member breakdown) ────────────────

  async getTeamRevenue(teamId: string, dateFrom?: string, dateTo?: string) {
    const teamOid      = new mongoose.Types.ObjectId(teamId);
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);
    const teamFilter   = { team: teamOid };

    const [summaryAgg, memberAgg] = await Promise.all([
      Lead.aggregate([
        { $match: teamFilter },
        { $unwind: "$payments" },
        { $match: paymentMatch },
        {
          $group: {
            _id:          null,
            totalRevenue: { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
      ]),

      Lead.aggregate([
        { $match: teamFilter },
        { $unwind: "$payments" },
        { $match: paymentMatch },
        {
          $group: {
            _id:          "$assignedTo",
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
        { $sort: { revenue: -1 } },
        {
          $lookup: {
            from: "users", localField: "_id", foreignField: "_id", as: "userInfo",
          },
        },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            userId:       "$_id",
            name:         { $ifNull: ["$userInfo.name", "Unassigned"] },
            designation:  "$userInfo.designation",
            revenue:      1,
            paymentCount: 1,
            leadCount:    { $size: "$leadIds" },
          },
        },
      ]),
    ]);

    const summary         = summaryAgg[0] ?? { totalRevenue: 0, paymentCount: 0, leadIds: [] };
    const totalRevenue    = summary.totalRevenue   as number ?? 0;
    const paymentCount    = summary.paymentCount   as number ?? 0;
    const payingLeadCount = (summary.leadIds as unknown[])?.length ?? 0;
    const avgRevenuePerLead = payingLeadCount > 0
      ? +((totalRevenue / payingLeadCount).toFixed(2))
      : 0;

    const topMember = memberAgg[0]
      ? { name: memberAgg[0].name as string, revenue: memberAgg[0].revenue as number, designation: memberAgg[0].designation as string | undefined }
      : null;

    return {
      totalRevenue,
      payingLeadCount,
      paymentCount,
      avgRevenuePerLead,
      topMember,
      memberBreakdown: memberAgg.map((m, i) => ({
        ...m,
        rank: i + 1,
        pct: totalRevenue > 0
          ? +(((m.revenue as number) / totalRevenue) * 100).toFixed(1)
          : 0,
      })),
    };
  }

  // ── 10. Team-scoped revenue timeline (by member, per time bucket) ─────────────

  async getTeamRevenueTimeline(
    teamId: string,
    period: "daily" | "weekly" | "monthly" | "yearly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const teamOid      = new mongoose.Types.ObjectId(teamId);
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bucketId: any;
    if (period === "daily") {
      bucketId = { $dateToString: { format: "%Y-%m-%d", date: "$payments.paidAt" } };
    } else if (period === "weekly") {
      bucketId = { year: { $isoWeekYear: "$payments.paidAt" }, week: { $isoWeek: "$payments.paidAt" } };
    } else if (period === "monthly") {
      bucketId = { year: { $year: "$payments.paidAt" }, month: { $month: "$payments.paidAt" } };
    } else {
      bucketId = { year: { $year: "$payments.paidAt" } };
    }

    const agg = await Lead.aggregate([
      { $match: { team: teamOid } },
      { $unwind: "$payments" },
      { $match: paymentMatch },
      {
        $group: {
          _id:     { bucket: bucketId, member: "$assignedTo" },
          revenue: { $sum: "$payments.amount" },
        },
      },
      { $sort: { "_id.bucket": 1 } },
      {
        $lookup: {
          from: "users", localField: "_id.member", foreignField: "_id", as: "userInfo",
        },
      },
      { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bucket:     "$_id.bucket",
          memberName: { $ifNull: ["$userInfo.name", "Unassigned"] },
          revenue:    1,
        },
      },
    ]);

    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const memberSet = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucketMap = new Map<string, Record<string, any>>();

    for (const row of agg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = row.bucket as any;
      let label: string;
      if (typeof b === "string") {
        label = b;
      } else if (b?.week !== undefined) {
        label = `W${b.week as number} '${String(b.year as number).slice(2)}`;
      } else if (b?.month !== undefined) {
        label = `${MONTHS[b.month as number]} '${String(b.year as number).slice(2)}`;
      } else {
        label = String(b?.year ?? "—");
      }

      const memberName = row.memberName as string;
      memberSet.add(memberName);

      if (!bucketMap.has(label)) bucketMap.set(label, { label, total: 0 });
      const bucket = bucketMap.get(label)!;
      bucket[memberName] = ((bucket[memberName] as number) ?? 0) + (row.revenue as number);
      bucket.total       = ((bucket.total       as number) ?? 0) + (row.revenue as number);
    }

    return {
      members:  Array.from(memberSet),
      timeline: Array.from(bucketMap.values()),
    };
  }

  // ── 11. Status breakdown by period (for comparing periods) ────────────────────

  async getStatusByPeriod(
    period: "daily" | "weekly" | "monthly",
    status: LeadStatus,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const match = {
      ...this.buildDateFilter(dateFrom, dateTo),
      status,
    };

    const groupId =
      period === "daily"
        ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        : period === "weekly"
        ? { year: { $isoWeekYear: "$createdAt" }, week: { $isoWeek: "$createdAt" } }
        : { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } };

    return Lead.aggregate([
      { $match: match },
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
  }
}
