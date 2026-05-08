#!/usr/bin/env bun
/**
 * Carlton CRM — MCP Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Exposes Carlton CRM data to any MCP-compatible client (Claude Code, Claude
 * Desktop, etc.) so AI can query leads, teams, users and reports in real time.
 *
 * Usage (Claude Code .mcp.json):
 *   {
 *     "mcpServers": {
 *       "carlton-crm": {
 *         "command": "bun",
 *         "args": ["mcp-server/index.ts"],
 *         "cwd": "/Users/mhdabshar/delta/carlton/crm/backend"
 *       }
 *     }
 *   }
 *
 * Available tools:
 *   get_crm_summary      — overall stats across all collections
 *   search_leads         — find leads by name/phone/status/team
 *   get_lead             — full lead detail by ID
 *   get_team_stats       — performance stats for a specific team
 *   get_user_stats       — performance stats for a specific user
 *   get_due_reminders    — all reminders due today or overdue
 */

import "dotenv/config";
import { Server }           from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mongoose, { Types } from "mongoose";
import { env } from "../src/config/env.js";

// ── Models ────────────────────────────────────────────────────────────────────
import { Lead }   from "../src/models/Lead.js";
import { Team }   from "../src/models/Team.js";
import { User }   from "../src/models/User.js";
import { Course } from "../src/models/Course.js";

// ── DB connect ────────────────────────────────────────────────────────────────
await mongoose.connect(env.MONGODB_URI);

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "carlton-crm", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_crm_summary",
      description: "Get a high-level summary of the entire CRM: lead counts by status, top teams, top performers, and recent activity. No input required.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "search_leads",
      description: "Search for leads by name, phone, email, status, or team name. Returns up to 20 matching leads with key fields.",
      inputSchema: {
        type: "object",
        properties: {
          query:  { type: "string", description: "Name, phone, or email to search for" },
          status: { type: "string", description: "Filter by lead status (new, assigned, followup, closed, rejected, cnc, booking, partialbooking, interested)" },
          team:   { type: "string", description: "Filter by team name (partial match)" },
          limit:  { type: "number", description: "Max results to return (default 20, max 50)" },
        },
        required: [],
      },
    },
    {
      name: "get_lead",
      description: "Get full details of a specific lead by MongoDB ID, including notes, reminders, payments, and activity logs.",
      inputSchema: {
        type: "object",
        properties: {
          leadId: { type: "string", description: "MongoDB ObjectId of the lead" },
        },
        required: ["leadId"],
      },
    },
    {
      name: "get_team_stats",
      description: "Get detailed performance statistics for a team: member list, lead counts by status, and per-member conversion breakdown.",
      inputSchema: {
        type: "object",
        properties: {
          teamId:   { type: "string", description: "MongoDB ObjectId of the team" },
          teamName: { type: "string", description: "Team name (partial match) — alternative to teamId" },
        },
        required: [],
      },
    },
    {
      name: "get_user_stats",
      description: "Get performance statistics for a specific CRM user: their leads by status, conversion rate, and recent activity.",
      inputSchema: {
        type: "object",
        properties: {
          userId:   { type: "string", description: "MongoDB ObjectId of the user" },
          userName: { type: "string", description: "User name (partial match) — alternative to userId" },
        },
        required: [],
      },
    },
    {
      name: "get_due_reminders",
      description: "Get all reminders that are due today or overdue (not yet marked as done). Useful for daily standup context.",
      inputSchema: {
        type: "object",
        properties: {
          hoursAhead: { type: "number", description: "Also include reminders due in the next N hours (default 0 = only overdue/due now)" },
        },
        required: [],
      },
    },
  ],
}));

// ── Tool implementations ──────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {

      // ── get_crm_summary ───────────────────────────────────────────────────
      case "get_crm_summary": {
        const [statusCounts, last30, topUsers, topTeams, totalUsers, totalTeams, totalCourses] =
          await Promise.all([
            Lead.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
            Lead.aggregate([
              { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } } },
              { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
            Lead.aggregate([
              { $match: { status: { $in: ["closed", "booking", "partialbooking"] }, assignedTo: { $ne: null } } },
              { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
              { $sort: { count: -1 } }, { $limit: 5 },
              { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
              { $unwind: "$u" },
              { $project: { name: "$u.name", count: 1, _id: 0 } },
            ]),
            Lead.aggregate([
              { $match: { status: { $in: ["closed", "booking", "partialbooking"] }, team: { $ne: null } } },
              { $group: { _id: "$team", count: { $sum: 1 } } },
              { $sort: { count: -1 } }, { $limit: 5 },
              { $lookup: { from: "teams", localField: "_id", foreignField: "_id", as: "t" } },
              { $unwind: "$t" },
              { $project: { name: "$t.name", count: 1, _id: 0 } },
            ]),
            User.countDocuments({ status: "active" }),
            Team.countDocuments({ status: "active" }),
            Course.countDocuments(),
          ]);

        const all: Record<string, number> = {};
        for (const s of statusCounts) all[s._id as string] = s.count as number;
        const totalLeads = Object.values(all).reduce((a, b) => a + b, 0);

        const last30Obj: Record<string, number> = {};
        for (const s of last30) last30Obj[s._id as string] = s.count as number;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              summary: {
                totalLeads, totalUsers, totalTeams, totalCourses,
                leadsByStatus: all,
                last30Days: last30Obj,
                conversionRate: totalLeads > 0
                  ? `${(((all.closed ?? 0) + (all.booking ?? 0) + (all.partialbooking ?? 0)) / totalLeads * 100).toFixed(1)}%`
                  : "0%",
              },
              topPerformers: topUsers,
              topTeams,
            }, null, 2),
          }],
        };
      }

      // ── search_leads ──────────────────────────────────────────────────────
      case "search_leads": {
        const query  = String(a.query ?? "");
        const status = String(a.status ?? "");
        const teamQ  = String(a.team ?? "");
        const limit  = Math.min(Number(a.limit ?? 20), 50);

        const filter: Record<string, unknown> = {};

        if (query) {
          filter.$or = [
            { name:  { $regex: query, $options: "i" } },
            { phone: { $regex: query, $options: "i" } },
            { email: { $regex: query, $options: "i" } },
          ];
        }
        if (status) filter.status = status;

        if (teamQ) {
          const teams = await Team.find({ name: { $regex: teamQ, $options: "i" } }).select("_id").lean();
          filter.team = { $in: teams.map((t) => t._id) };
        }

        const leads = await Lead.find(filter)
          .populate("assignedTo", "name")
          .populate("team", "name")
          .populate("course", "name amount")
          .select("name phone email status source createdAt updatedAt")
          .sort({ updatedAt: -1 })
          .limit(limit)
          .lean();

        return {
          content: [{
            type: "text",
            text: JSON.stringify(leads.map((l) => ({
              id: l._id.toString(),
              name: l.name,
              phone: l.phone,
              email: l.email,
              status: l.status,
              source: l.source,
              assignedTo: (l.assignedTo as unknown as { name?: string } | null)?.name ?? "Unassigned",
              team: (l.team as unknown as { name?: string } | null)?.name ?? "None",
              course: (l.course as unknown as { name?: string } | null)?.name ?? "None",
              createdAt: l.createdAt,
              updatedAt: l.updatedAt,
            })), null, 2),
          }],
        };
      }

      // ── get_lead ──────────────────────────────────────────────────────────
      case "get_lead": {
        const leadId = String(a.leadId ?? "");
        if (!Types.ObjectId.isValid(leadId)) {
          return { content: [{ type: "text", text: `Error: "${leadId}" is not a valid MongoDB ObjectId` }] };
        }

        const lead = await Lead.findById(leadId)
          .populate("assignedTo", "name email")
          .populate("team", "name")
          .populate("course", "name amount")
          .populate("notes.author", "name")
          .lean();

        if (!lead) return { content: [{ type: "text", text: `Lead not found: ${leadId}` }] };

        const paymentsArr = Array.from(lead.payments ?? []) as unknown as { amount: number; date: string }[];
        const totalPaid = paymentsArr.reduce((s, p) => s + (p.amount || 0), 0);

        // Due reminders
        const dueReminders = (lead.reminders ?? []).filter((r) =>
          !r.isDone && new Date(r.remindAt) <= new Date(Date.now() + 24 * 3_600_000)
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: lead._id.toString(),
              name: lead.name,
              phone: lead.phone,
              email: lead.email,
              status: lead.status,
              source: lead.source,
              assignedTo: (lead.assignedTo as unknown as { name?: string } | null)?.name,
              team: (lead.team as unknown as { name?: string } | null)?.name,
              course: (lead.course as unknown as { name?: string; amount?: number } | null)?.name,
              courseAmount: (lead.course as unknown as { amount?: number } | null)?.amount,
              totalPaid,
  
              createdAt: lead.createdAt,
              updatedAt: lead.updatedAt,
              notes: lead.notes.slice(-5).map((n) => ({
                content: n.content,
                author: (n.author as unknown as { name?: string } | null)?.name,
                date: n.createdAt,
              })),
              dueReminders: dueReminders.map((r) => ({
                title: r.title,
                remindAt: r.remindAt,
              })),
              recentActivity: lead.activityLogs.slice(-5).map((a) => ({
                description: a.description,
                date: a.createdAt,
              })),
            }, null, 2),
          }],
        };
      }

      // ── get_team_stats ────────────────────────────────────────────────────
      case "get_team_stats": {
        let team = null;
        if (a.teamId && Types.ObjectId.isValid(String(a.teamId))) {
          team = await Team.findById(a.teamId).populate("members", "name designation").populate("leaders", "name").lean();
        } else if (a.teamName) {
          team = await Team.findOne({ name: { $regex: String(a.teamName), $options: "i" } })
            .populate("members", "name designation").populate("leaders", "name").lean();
        }

        if (!team) return { content: [{ type: "text", text: "Team not found. Provide teamId or teamName." }] };

        const teamOid = team._id as Types.ObjectId;
        const [statusCounts, memberStats] = await Promise.all([
          Lead.aggregate([
            { $match: { team: teamOid } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
          Lead.aggregate([
            { $match: { team: teamOid, assignedTo: { $ne: null } } },
            { $group: { _id: "$assignedTo", total: { $sum: 1 }, closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } }, booking: { $sum: { $cond: [{ $in: ["$status", ["booking", "partialbooking"]] }, 1, 0] } }, followup: { $sum: { $cond: [{ $eq: ["$status", "followup"] }, 1, 0] } } } },
            { $sort: { total: -1 } },
          ]),
        ]);

        const stats: Record<string, number> = {};
        for (const s of statusCounts) stats[s._id as string] = s.count as number;
        const total = Object.values(stats).reduce((a, b) => a + b, 0);

        const members = Array.isArray(team.members)
          ? team.members.map((m: unknown) => {
              if (!m || typeof m !== "object") return null;
              const typed = m as { _id: { toString(): string }; name: string; designation?: string };
              const ms = memberStats.find((s) => s._id?.toString() === typed._id.toString());
              return {
                name: typed.name,
                designation: typed.designation,
                totalLeads: ms?.total ?? 0,
                closed: ms?.closed ?? 0,
                bookings: ms?.booking ?? 0,
                followup: ms?.followup ?? 0,
                conversionRate: ms?.total ? `${(((ms.closed + ms.booking) / ms.total) * 100).toFixed(1)}%` : "0%",
              };
            }).filter(Boolean)
          : [];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              team: { id: team._id.toString(), name: team.name, status: team.status },
              leaders: Array.isArray(team.leaders)
                ? team.leaders.map((l: unknown) => (l && typeof l === "object" && "name" in l ? (l as { name: string }).name : ""))
                : [],
              totalLeads: total,
              leadsByStatus: stats,
              memberCount: members.length,
              members,
            }, null, 2),
          }],
        };
      }

      // ── get_user_stats ────────────────────────────────────────────────────
      case "get_user_stats": {
        let user = null;
        if (a.userId && Types.ObjectId.isValid(String(a.userId))) {
          user = await User.findById(a.userId).select("name email designation status").lean();
        } else if (a.userName) {
          user = await User.findOne({ name: { $regex: String(a.userName), $options: "i" } })
            .select("name email designation status").lean();
        }

        if (!user) return { content: [{ type: "text", text: "User not found. Provide userId or userName." }] };

        const userOid = user._id as Types.ObjectId;
        const [statusCounts, last30] = await Promise.all([
          Lead.aggregate([
            { $match: { assignedTo: userOid } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
          Lead.aggregate([
            { $match: { assignedTo: userOid, createdAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
        ]);

        const all: Record<string, number> = {};
        for (const s of statusCounts) all[s._id as string] = s.count as number;
        const total = Object.values(all).reduce((a, b) => a + b, 0);

        const last30Obj: Record<string, number> = {};
        for (const s of last30) last30Obj[s._id as string] = s.count as number;

        const conversions = (all.closed ?? 0) + (all.booking ?? 0) + (all.partialbooking ?? 0);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              user: { id: user._id.toString(), name: user.name, email: user.email, designation: (user as { designation?: string }).designation, status: user.status },
              totalLeads: total,
              leadsByStatus: all,
              conversions,
              conversionRate: total > 0 ? `${((conversions / total) * 100).toFixed(1)}%` : "0%",
              last30Days: last30Obj,
            }, null, 2),
          }],
        };
      }

      // ── get_due_reminders ─────────────────────────────────────────────────
      case "get_due_reminders": {
        const hoursAhead = Number(a.hoursAhead ?? 0);
        const cutoff = new Date(Date.now() + hoursAhead * 3_600_000);

        const leads = await Lead.find({
          "reminders": {
            $elemMatch: { isDone: false, remindAt: { $lte: cutoff } },
          },
        })
          .populate("assignedTo", "name")
          .select("name phone status reminders assignedTo")
          .lean();

        const results: object[] = [];
        for (const lead of leads) {
          const dueOnes = (lead.reminders ?? []).filter(
            (r) => !r.isDone && new Date(r.remindAt) <= cutoff
          );
          for (const r of dueOnes) {
            results.push({
              leadName: lead.name,
              leadPhone: lead.phone,
              leadStatus: lead.status,
              assignedTo: (lead.assignedTo as unknown as { name?: string } | null)?.name ?? "Unassigned",
              reminderTitle: r.title ?? "(no title)",
              remindAt: r.remindAt,
              overdue: new Date(r.remindAt) < new Date(),
            });
          }
        }

        results.sort((a, b) => {
          const ra = a as { remindAt: string };
          const rb = b as { remindAt: string };
          return new Date(ra.remindAt).getTime() - new Date(rb.remindAt).getTime();
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ count: results.length, reminders: results }, null, 2),
          }],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Tool error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Carlton CRM MCP server running (stdio)");
