import type { Request, Response, NextFunction } from "express";
import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";
import { ReportService } from "../services/reportService.js";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import mongoose from "mongoose";

const reportService = new ReportService();

function qs(req: Request) {
  return {
    dateFrom: req.query.dateFrom as string | undefined,
    dateTo:   req.query.dateTo   as string | undefined,
  };
}

function labelRange(dateFrom?: string, dateTo?: string) {
  if (dateFrom && dateTo) return `${dateFrom}  →  ${dateTo}`;
  if (dateFrom) return `From ${dateFrom}`;
  if (dateTo)   return `Up to ${dateTo}`;
  return "All time";
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel export  (3 sheets: Summary · Teams · Members)
// ─────────────────────────────────────────────────────────────────────────────

export const exportExcel = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = qs(req);

    const [teams, members, overview] = await Promise.all([
      reportService.getTeamRankings(dateFrom, dateTo),
      reportService.getUserRankings(dateFrom, dateTo, 200),
      reportService.getOverview(dateFrom, dateTo),
    ]);

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Summary ────────────────────────────────────────────────────
    const summaryRows: Record<string, unknown>[] = [
      { "Carlton CRM — Report Summary": "", "": labelRange(dateFrom, dateTo) },
      {},
      { "Carlton CRM — Report Summary": "KPI",          "": "Value" },
      { "Carlton CRM — Report Summary": "Total Leads",   "": overview.summary.total },
      { "Carlton CRM — Report Summary": "Closed Leads",  "": overview.summary.closed },
      { "Carlton CRM — Report Summary": "Conversion Rate", "": `${overview.summary.conversionRate}%` },
      { "Carlton CRM — Report Summary": "Active Teams",  "": overview.summary.activeTeams },
      { "Carlton CRM — Report Summary": "Active Users",  "": overview.summary.activeUsers },
      {},
      { "Carlton CRM — Report Summary": "Status",        "": "Count" },
      ...overview.statusDistribution.map((s) => ({
        "Carlton CRM — Report Summary": s.status.toUpperCase(),
        "": s.count,
      })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Summary");

    // ── Sheet 2: Teams ──────────────────────────────────────────────────────
    const teamsRows = teams.map((t) => ({
      Rank:              t.rank,
      Team:              t.name,
      "Total Members":   (t as Record<string, unknown>).memberCount ?? 0,
      "Total Leads":     t.total,
      "Revenue (₹)":     (t as Record<string, unknown>).totalPayments ?? 0,
      New:               t.new,
      Assigned:          t.assigned,
      "Follow Up":       t.followup,
      Interested:        t.interested,
      CNC:               t.cnc,
      Booking:           t.booking,
      "Partial Booking": (t as Record<string, unknown>).partialbooking ?? 0,
      Closed:            t.closed,
      Rejected:          t.rejected,
      "Conversion Rate (%)": t.conversionRate,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(teamsRows), "Teams");

    // ── Sheet 3: Members ────────────────────────────────────────────────────
    const membersRows = members.map((m) => ({
      Rank:              m.rank,
      Name:              m.name,
      Email:             m.email,
      Designation:       (m as Record<string, unknown>).designation ?? "-",
      "Total Leads":     m.total,
      New:               m.new,
      Assigned:          m.assigned,
      "Follow Up":       m.followup,
      Interested:        m.interested,
      CNC:               m.cnc,
      Booking:           m.booking,
      "Partial Booking": (m as Record<string, unknown>).partialbooking ?? 0,
      Closed:            m.closed,
      Rejected:          m.rejected,
      "Conversion Rate (%)": m.conversionRate,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(membersRows), "Members");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const filename = `crm-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PDF export  (Teams + Members with status breakdown)
// ─────────────────────────────────────────────────────────────────────────────

const BLUE   = "#3b82f6";
const GREEN  = "#22c55e";
const GRAY   = "#64748b";
const DARK   = "#0f172a";
const LIGHT  = "#f1f5f9";
const WHITE  = "#ffffff";
const AMBER  = "#f59e0b";

function pdfTable(
  doc:     InstanceType<typeof PDFDocument>,
  headers: string[],
  colW:    number[],
  rows:    (string | number)[][],
  startX:  number,
  startY:  number,
  rowH     = 20,
) {
  const totalW = colW.reduce((a, b) => a + b, 0);

  // Header row
  doc.rect(startX, startY, totalW, rowH).fill(BLUE);
  doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(7.5);
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x + 4, startY + 6, { width: colW[i] - 6, align: i === 0 ? "left" : "center" });
    x += colW[i];
  });

  // Data rows
  doc.font("Helvetica").fontSize(7).fillColor(DARK);
  rows.forEach((row, ri) => {
    const y = startY + rowH * (ri + 1);
    if (y + rowH > doc.page.height - 50) { doc.addPage(); }

    const bg = ri % 2 === 0 ? WHITE : LIGHT;
    doc.rect(startX, y, totalW, rowH).fill(bg);

    doc.fillColor(DARK);
    let cx = startX;
    row.forEach((cell, ci) => {
      doc.text(String(cell ?? "-"), cx + 4, y + 6, {
        width: colW[ci] - 6,
        align: ci === 0 ? "left" : "center",
      });
      cx += colW[ci];
    });

    // Row border
    doc.rect(startX, y, totalW, rowH).stroke("#e2e8f0");
  });

  return startY + rowH * (rows.length + 1);
}

export const exportPdf = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = qs(req);

    const [teams, members, overview] = await Promise.all([
      reportService.getTeamRankings(dateFrom, dateTo),
      reportService.getUserRankings(dateFrom, dateTo, 200),
      reportService.getOverview(dateFrom, dateTo),
    ]);

    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));

    const finish = new Promise<void>((resolve) => doc.on("end", resolve));

    const pageW = doc.page.width - 80; // usable width after margins

    // ── Cover header ──────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 60).fill(BLUE);
    doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(18)
       .text("Carlton CRM — Report", 40, 18);
    doc.font("Helvetica").fontSize(10)
       .text(`Period: ${labelRange(dateFrom, dateTo)}   ·   Generated: ${new Date().toLocaleDateString("en-GB")}`, 40, 40);

    let y = 80;

    // ── KPI summary row ───────────────────────────────────────────────────────
    const kpis = [
      ["Total Leads",   overview.summary.total],
      ["Closed",        overview.summary.closed],
      ["Conversion",    `${overview.summary.conversionRate}%`],
      ["Active Teams",  overview.summary.activeTeams],
      ["Active Users",  overview.summary.activeUsers],
    ];
    const kpiW = pageW / kpis.length;
    kpis.forEach(([label, val], i) => {
      const kx = 40 + i * kpiW;
      doc.rect(kx, y, kpiW - 6, 40).fill(LIGHT);
      doc.fillColor(GRAY).font("Helvetica").fontSize(7.5)
         .text(String(label), kx + 6, y + 6, { width: kpiW - 12 });
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(14)
         .text(String(val), kx + 6, y + 17, { width: kpiW - 12 });
    });

    y += 56;

    // ── Status summary row ────────────────────────────────────────────────────
    const statuses = overview.statusDistribution;
    const sW = pageW / statuses.length;
    const statusColors: Record<string, string> = {
      new:"#3b82f6", assigned:"#eab308", followup:"#f97316",
      interested:"#8b5cf6", cnc:"#64748b", booking:"#14b8a6",
      partialbooking:"#ec4899", closed:"#22c55e", rejected:"#ef4444",
    };
    statuses.forEach((s, i) => {
      const sx = 40 + i * sW;
      doc.rect(sx, y, sW - 4, 28).fill(statusColors[s.status] ?? GRAY);
      doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(6.5)
         .text(s.status.toUpperCase(), sx + 4, y + 4, { width: sW - 8, align: "center" });
      doc.fontSize(11)
         .text(String(s.count), sx + 4, y + 12, { width: sW - 8, align: "center" });
    });

    y += 42;

    // ── Teams table ───────────────────────────────────────────────────────────
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text("Team Rankings", 40, y);
    y += 16;

    const teamHeaders = ["Rank","Team","Members","Leads","Revenue(₹)","New","Assigned","Follow Up","Interested","CNC","Booking","Part.Bkg","Closed","Rejected","Conv %"];
    const teamColW    = [26, 82, 38, 32, 54, 28, 38, 44, 50, 28, 38, 40, 32, 38, 36];

    const teamRows = teams.map((t) => [
      t.rank, t.name, (t as Record<string, unknown>).memberCount ?? 0,
      t.total, (t as Record<string, unknown>).totalPayments ?? 0,
      t.new, t.assigned, t.followup, t.interested,
      t.cnc, t.booking, (t as Record<string, unknown>).partialbooking ?? 0,
      t.closed, t.rejected, `${t.conversionRate}%`,
    ]);

    y = pdfTable(doc, teamHeaders, teamColW, teamRows as (string | number)[][], 40, y);
    y += 24;

    // ── Members table (new page if needed) ────────────────────────────────────
    if (y + 120 > doc.page.height - 50) {
      doc.addPage();
      y = 40;
    }

    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text("Member Rankings", 40, y);
    y += 16;

    const memHeaders = ["Rank","Name","Email","Designation","Total","New","Assigned","Followup","Interested","CNC","Booking","Part.Bkg","Closed","Rejected","Conv %"];
    const memColW    = [26, 80, 100, 60, 32, 26, 36, 38, 44, 26, 36, 38, 32, 36, 36];

    const memRows = members.map((m) => [
      m.rank, m.name, m.email, (m as Record<string, unknown>).designation ?? "-",
      m.total, m.new, m.assigned, m.followup, m.interested,
      m.cnc, m.booking, (m as Record<string, unknown>).partialbooking ?? 0,
      m.closed, m.rejected, `${m.conversionRate}%`,
    ]);

    pdfTable(doc, memHeaders, memColW, memRows as (string | number)[][], 40, y);

    // Footer on every page
    const pageCount = (doc as unknown as { _pageBuffer: unknown[] })._pageBuffer?.length ?? 1;
    for (let p = 0; p < pageCount; p++) {
      doc.switchToPage(p);
      doc.rect(0, doc.page.height - 28, doc.page.width, 28).fill(DARK);
      doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(7)
         .text("Carlton CRM", 40, doc.page.height - 18);
      doc.fillColor(WHITE).font("Helvetica").fontSize(7)
         .text(`Page ${p + 1}  ·  Confidential`, doc.page.width / 2, doc.page.height - 18, { align: "center", width: doc.page.width - 80 });
    }

    doc.end();
    await finish;

    const pdf = Buffer.concat(chunks);
    const filename = `crm-report-${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length",      pdf.length);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared PDF helpers
// ─────────────────────────────────────────────────────────────────────────────

const ALL_STATUSES_EX = [
  "new", "assigned", "followup", "interested", "cnc", "booking", "partialbooking", "closed", "rejected",
] as const;

const STATUS_COLORS_EX: Record<string, string> = {
  new:"#3b82f6", assigned:"#eab308", followup:"#f97316",
  interested:"#8b5cf6", cnc:"#64748b", booking:"#14b8a6",
  partialbooking:"#ec4899", closed:"#22c55e", rejected:"#ef4444",
};

function buildDateMatch(dateFrom?: string, dateTo?: string): Record<string, unknown> {
  if (!dateFrom && !dateTo) return {};
  const f: Record<string, Date> = {};
  if (dateFrom) f["$gte"] = new Date(dateFrom + "T00:00:00.000Z");
  if (dateTo)   f["$lte"] = new Date(dateTo   + "T23:59:59.999Z");
  return { createdAt: f };
}

function sendPdf(res: Response, buf: Buffer, name: string) {
  res.setHeader("Content-Type",        "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Content-Length",      buf.length);
  res.send(buf);
}

function pdfHeader(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
  subtitle: string,
) {
  doc.rect(0, 0, doc.page.width, 56).fill(BLUE);
  doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(16).text(title, 40, 14);
  doc.font("Helvetica").fontSize(9).text(subtitle, 40, 34);
}

function pdfFooter(doc: InstanceType<typeof PDFDocument>) {
  const pages = (doc as unknown as { _pageBuffer: unknown[] })._pageBuffer?.length ?? 1;
  for (let p = 0; p < pages; p++) {
    doc.switchToPage(p);
    doc.rect(0, doc.page.height - 24, doc.page.width, 24).fill(DARK);
    doc.fillColor(AMBER).font("Helvetica-Bold").fontSize(7).text("Carlton CRM", 40, doc.page.height - 15);
    doc.fillColor(WHITE).font("Helvetica").fontSize(7)
       .text(`Page ${p + 1}  ·  Confidential`, doc.page.width / 2, doc.page.height - 15, {
         align: "center", width: doc.page.width - 80,
       });
  }
}

function statusBar(
  doc: InstanceType<typeof PDFDocument>,
  counts: Record<string, number>,
  total: number,
  x: number,
  y: number,
  w: number,
) {
  const sW = w / ALL_STATUSES_EX.length;
  ALL_STATUSES_EX.forEach((s, i) => {
    const sx = x + i * sW;
    const cnt = counts[s] ?? 0;
    doc.rect(sx, y, sW - 3, 26).fill(STATUS_COLORS_EX[s] ?? GRAY);
    doc.fillColor(WHITE).font("Helvetica-Bold").fontSize(6)
       .text(s.toUpperCase(), sx + 2, y + 3, { width: sW - 4, align: "center" });
    doc.fontSize(9).text(String(cnt), sx + 2, y + 12, { width: sW - 4, align: "center" });
  });
  // Conversion rate
  const cr = total > 0 ? ((counts["closed"] ?? 0) / total * 100).toFixed(1) : "0.0";
  doc.fillColor(DARK).font("Helvetica").fontSize(8)
     .text(`Total: ${total}   Closed: ${counts["closed"] ?? 0}   Conversion: ${cr}%`, x, y + 32, { width: w });
  return y + 46;
}

// ─────────────────────────────────────────────────────────────────────────────
// Team PDF  GET /teams/:id/export-pdf?dateFrom=&dateTo=
// ─────────────────────────────────────────────────────────────────────────────

export const exportTeamPdf = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const teamId    = req.params.id;
    const { dateFrom, dateTo } = qs(req);

    // ── Fetch team ────────────────────────────────────────────────────────────
    const team = await Team.findById(teamId)
      .populate("leaders", "name email designation")
      .populate("members", "name email designation")
      .lean();
    if (!team) { res.status(404).json({ message: "Team not found" }); return; }

    const match = { team: new mongoose.Types.ObjectId(teamId), ...buildDateMatch(dateFrom, dateTo) };

    // ── Status counts ─────────────────────────────────────────────────────────
    const statusAgg = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const statusCounts: Record<string, number> = {};
    ALL_STATUSES_EX.forEach((s) => (statusCounts[s] = 0));
    let teamTotal = 0;
    for (const item of statusAgg) { statusCounts[item._id] = item.count; teamTotal += item.count; }

    // ── Member performance ────────────────────────────────────────────────────
    type MemberRow = { name: string; total: number; totalPayments: number; closed: number; followup: number; cnc: number; booking: number; partialbooking: number; interested: number; cr: string };
    const leaderIds = new Set(
      (team.leaders as unknown as { _id: { toString(): string } }[]).map((l) => l._id.toString()),
    );
    const allUsers = [
      ...(team.leaders as unknown as { _id: { toString(): string }; name: string }[]),
      ...(team.members as unknown as { _id: { toString(): string }; name: string }[]),
    ].filter((u, i, a) => a.findIndex((x) => x._id.toString() === u._id.toString()) === i);

    const memberRows: MemberRow[] = await Promise.all(
      allUsers.map(async (u) => {
        const uid  = u._id.toString();
        const agg2 = await Lead.aggregate([
          { $match: { ...match, assignedTo: new mongoose.Types.ObjectId(uid) } },
          { $group: { _id: null,
            total:          { $sum: 1 },
            totalPayments:  { $sum: { $sum: "$payments.amount" } },
            closed:         { $sum: { $cond: [{ $eq: ["$status","closed"] },         1, 0] } },
            followup:       { $sum: { $cond: [{ $eq: ["$status","followup"] },       1, 0] } },
            cnc:            { $sum: { $cond: [{ $eq: ["$status","cnc"] },            1, 0] } },
            booking:        { $sum: { $cond: [{ $eq: ["$status","booking"] },        1, 0] } },
            partialbooking: { $sum: { $cond: [{ $eq: ["$status","partialbooking"] }, 1, 0] } },
            interested:     { $sum: { $cond: [{ $eq: ["$status","interested"] },     1, 0] } },
          }},
        ]);
        const d = agg2[0] ?? { total:0, totalPayments:0, closed:0, followup:0, cnc:0, booking:0, partialbooking:0, interested:0 };
        const cr = d.total > 0 ? ((d.closed / d.total) * 100).toFixed(1) : "0.0";
        const role = leaderIds.has(uid) ? " (Leader)" : "";
        return { name: u.name + role, total:d.total, totalPayments:d.totalPayments, closed:d.closed, followup:d.followup, cnc:d.cnc, booking:d.booking, partialbooking:d.partialbooking, interested:d.interested, cr };
      }),
    );
    // Best performer = highest total payments collected
    memberRows.sort((a, b) => b.totalPayments - a.totalPayments);

    // ── Build PDF ─────────────────────────────────────────────────────────────
    const doc    = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const finish = new Promise<void>((resolve) => doc.on("end", resolve));

    const W = doc.page.width - 80;
    pdfHeader(doc, `${(team as unknown as { name: string }).name} — Team Report`, `Period: ${labelRange(dateFrom, dateTo)}   ·   Generated: ${new Date().toLocaleDateString("en-GB")}`);

    let y = 70;

    // Team meta
    const t = team as unknown as { name: string; description?: string; status: string };
    doc.rect(40, y, W, 38).fill(LIGHT);
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text(t.name, 48, y + 6);
    doc.font("Helvetica").fontSize(8).fillColor(GRAY)
       .text(`Status: ${t.status}   ·   Leaders: ${(team.leaders as unknown[]).length}   ·   Members: ${(team.members as unknown[]).length}`, 48, y + 20);
    if (t.description) {
      doc.fontSize(8).fillColor(GRAY).text(t.description, 48, y + 30, { width: W - 16 });
    }
    y += 48;

    // Status bar
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text("Lead Status Distribution", 40, y);
    y += 14;
    y = statusBar(doc, statusCounts, teamTotal, 40, y, W);
    y += 16;

    // Member table
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text("Member Performance", 40, y);
    y += 12;
    const mHeaders = ["Member", "Total", "Revenue(₹)", "Closed", "Follow Up", "Interested", "CNC", "Booking", "Part.Bkg", "Conv %"];
    const mColW    = [130, 34, 58, 34, 44, 50, 32, 40, 40, 40];
    y = pdfTable(doc, mHeaders, mColW, memberRows.map((r) =>
      [r.name, r.total, r.totalPayments, r.closed, r.followup, r.interested, r.cnc, r.booking, r.partialbooking, `${r.cr}%`]
    ), 40, y);

    pdfFooter(doc);
    doc.end();
    await finish;

    const teamSlug = (team as unknown as { name: string }).name.toLowerCase().replace(/\s+/g, "-");
    sendPdf(res, Buffer.concat(chunks), `team-${teamSlug}-${new Date().toISOString().slice(0,10)}.pdf`);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// User PDF  GET /users/:id/export-pdf?dateFrom=&dateTo=
//           GET /users/profile/export-pdf?dateFrom=&dateTo=  (self)
// ─────────────────────────────────────────────────────────────────────────────

export const exportUserPdf = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Support both /:id and /profile (self)
    const userId = req.params.id === "profile" || !req.params.id
      ? (req as unknown as { user: { userId: string } }).user?.userId
      : req.params.id;

    const { dateFrom, dateTo } = qs(req);

    const userDoc = await User.findById(userId).populate("role", "roleName").lean();
    if (!userDoc) { res.status(404).json({ message: "User not found" }); return; }

    const u = userDoc as unknown as { name: string; email: string; designation?: string; status: string; role?: { roleName: string }; createdAt: string };
    const match = { assignedTo: new mongoose.Types.ObjectId(userId!), ...buildDateMatch(dateFrom, dateTo) };

    // Status counts
    const statusAgg = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const statusCounts: Record<string, number> = {};
    ALL_STATUSES_EX.forEach((s) => (statusCounts[s] = 0));
    let userTotal = 0;
    for (const item of statusAgg) { statusCounts[item._id] = item.count; userTotal += item.count; }

    // Top 10 recent closed leads
    const recentLeads = await Lead.find({ ...match, status: "closed" })
      .sort({ updatedAt: -1 })
      .limit(10)
      .select("name phone source createdAt")
      .lean();

    // Build PDF
    const doc    = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const finish = new Promise<void>((resolve) => doc.on("end", resolve));

    const W = doc.page.width - 80;
    pdfHeader(doc, `${u.name} — Performance Report`, `Period: ${labelRange(dateFrom, dateTo)}   ·   Generated: ${new Date().toLocaleDateString("en-GB")}`);

    let y = 70;

    // User info card
    doc.rect(40, y, W, 48).fill(LIGHT);
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(12).text(u.name, 48, y + 7);
    doc.font("Helvetica").fontSize(8).fillColor(GRAY).text(`${u.email}`, 48, y + 22);
    const meta = [u.designation, u.role?.roleName, `Status: ${u.status}`].filter(Boolean).join("   ·   ");
    doc.fontSize(8).text(meta, 48, y + 33, { width: W - 16 });
    y += 58;

    // Status bar
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text("Lead Status Breakdown", 40, y);
    y += 14;
    y = statusBar(doc, statusCounts, userTotal, 40, y, W);
    y += 16;

    // Performance summary table
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text("Performance Summary", 40, y);
    y += 12;
    const convRate = userTotal > 0 ? ((statusCounts.closed / userTotal) * 100).toFixed(1) : "0.0";
    const perfHeaders = ["Metric", "Value"];
    const perfColW    = [280, 230];
    const perfRows: (string | number)[][] = [
      ["Total Assigned Leads",  userTotal],
      ["Closed / Won",          statusCounts.closed],
      ["Conversion Rate",       `${convRate}%`],
      ["Follow Up",             statusCounts.followup],
      ["Interested",            statusCounts.interested],
      ["Booking",               statusCounts.booking],
      ["Partial Booking",       statusCounts.partialbooking ?? 0],
      ["CNC (Could Not Connect)", statusCounts.cnc],
      ["Rejected",              statusCounts.rejected],
      ["New (Unworked)",        statusCounts.new],
    ];
    y = pdfTable(doc, perfHeaders, perfColW, perfRows, 40, y);
    y += 20;

    // Recent closed leads
    if (recentLeads.length > 0) {
      if (y + 80 > doc.page.height - 50) { doc.addPage(); y = 50; }
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text("Recent Closed Leads (Top 10)", 40, y);
      y += 12;
      const lHeaders = ["Name", "Phone", "Source", "Created"];
      const lColW    = [170, 110, 80, 150];
      const lRows = recentLeads.map((l) => {
        const ld = l as unknown as { name: string; phone: string; source?: string; createdAt: string };
        return [ld.name, ld.phone ?? "-", ld.source ?? "-", new Date(ld.createdAt).toLocaleDateString("en-GB")];
      });
      pdfTable(doc, lHeaders, lColW, lRows, 40, y);
    }

    pdfFooter(doc);
    doc.end();
    await finish;

    const nameSlug = u.name.toLowerCase().replace(/\s+/g, "-");
    sendPdf(res, Buffer.concat(chunks), `user-${nameSlug}-${new Date().toISOString().slice(0,10)}.pdf`);
  } catch (err) {
    next(err);
  }
};
