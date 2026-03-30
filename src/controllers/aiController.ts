import type { Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { AiMemory } from "../models/AiMemory.js";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { env } from "../config/env.js";
import type { AiContextType } from "../models/AiMemory.js";
import mongoose from "mongoose";

const MAX_MEMORY_MESSAGES = 40;

function getGemini() {
  if (!env.GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

// ── System prompt builders ────────────────────────────────────────────────────

async function buildLeadPrompt(leadId: string): Promise<string> {
  const lead = await Lead.findById(leadId)
    .populate("assignedTo", "name email")
    .populate("team", "name")
    .populate("course", "name amount")
    .populate("notes.author", "name")
    .populate("activityLogs.performedBy", "name")
    .lean();

  if (!lead) return "You are a helpful CRM sales assistant.";

  const notesText = lead.notes.slice(-10).map((n) => {
    const author = typeof n.author === "object" && n.author && "name" in n.author
      ? (n.author as { name: string }).name : "Unknown";
    return `  - [${new Date(n.createdAt).toLocaleString()}] ${author}: ${n.content}`;
  }).join("\n");

  const activityText = lead.activityLogs.slice(-10).map((a) => {
    const by = typeof a.performedBy === "object" && a.performedBy && "name" in a.performedBy
      ? (a.performedBy as { name: string }).name : "Unknown";
    return `  - [${new Date(a.createdAt).toLocaleString()}] ${by}: ${a.description}`;
  }).join("\n");

  const paymentsArr = Array.from(lead.payments ?? []) as unknown as { amount: number }[];
  const totalPaid = paymentsArr.reduce((s, p) => s + p.amount, 0);
  const courseObj = typeof lead.course === "object" && lead.course ? lead.course as unknown as Record<string, unknown> : null;
  const courseAmount = courseObj && typeof courseObj.amount === "number" ? courseObj.amount : null;
  const courseName = courseObj && typeof courseObj.name === "string" ? courseObj.name : "None";
  const assignedObj = typeof lead.assignedTo === "object" && lead.assignedTo ? lead.assignedTo as unknown as Record<string, unknown> : null;
  const assignedName = assignedObj && typeof assignedObj.name === "string" ? assignedObj.name : "Unassigned";
  const teamObj = typeof lead.team === "object" && lead.team ? lead.team as unknown as Record<string, unknown> : null;
  const teamName = teamObj && typeof teamObj.name === "string" ? teamObj.name : "None";

  const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
  const paymentLine = courseAmount
    ? `${inr(totalPaid)} / ${inr(courseAmount)} (${((totalPaid / courseAmount) * 100).toFixed(1)}% paid)`
    : totalPaid > 0 ? `${inr(totalPaid)} total paid` : "No payments yet";

  return `You are an AI sales assistant for Carlton CRM. Help the sales rep manage this specific lead.

## Lead Details
- **Name**: ${lead.name}
- **Phone**: ${lead.phone ?? "N/A"}
- **Email**: ${lead.email ?? "N/A"}
- **Status**: ${lead.status}
- **Source**: ${lead.source ?? "N/A"}
- **Assigned To**: ${assignedName}
- **Team**: ${teamName}
- **Course**: ${courseName}
- **Payments**: ${paymentLine}
- **Created**: ${new Date(lead.createdAt).toLocaleString()}
- **Last Updated**: ${new Date(lead.updatedAt).toLocaleString()}

## Recent Notes
${notesText || "  None yet."}

## Recent Activity
${activityText || "  None yet."}

## Your Role
- Answer questions about this lead and provide sales insights
- Suggest follow-up actions, talking points, and next steps
- Help draft messages or emails to the lead
- Analyze payment progress and suggest collection strategies
- Summarize the lead's history on request
- Be concise, professional, and refer to the lead by name.`;
}

async function buildTeamPrompt(teamId: string): Promise<string> {
  const team = await Team.findById(teamId)
    .populate("leaders", "name email designation")
    .populate("members", "name email designation")
    .lean();

  if (!team) return "You are a helpful CRM team assistant.";

  // Get team lead stats
  const statusCounts = await Lead.aggregate([
    { $match: { team: new mongoose.Types.ObjectId(teamId) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const stats: Record<string, number> = {};
  for (const s of statusCounts) stats[s._id as string] = s.count as number;
  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  // Per-member stats
  const memberStats = await Lead.aggregate([
    { $match: { team: new mongoose.Types.ObjectId(teamId), assignedTo: { $ne: null } } },
    { $group: { _id: "$assignedTo", total: { $sum: 1 }, closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } }, booking: { $sum: { $cond: [{ $eq: ["$status", "booking"] }, 1, 0] } } } },
    { $sort: { total: -1 } },
  ]);

  const leaderNames = Array.isArray(team.leaders)
    ? team.leaders.map((l: unknown) => (l && typeof l === "object" && "name" in l ? (l as { name: string }).name : "Unknown")).join(", ")
    : "None";

  const memberList = Array.isArray(team.members)
    ? team.members.map((m: unknown) => {
        if (!m || typeof m !== "object" || !("name" in m)) return "";
        const typed = m as { _id: { toString(): string }; name: string; designation?: string };
        const ms = memberStats.find((s) => s._id?.toString() === typed._id.toString());
        return `  - ${typed.name}${typed.designation ? ` (${typed.designation})` : ""}: ${ms?.total ?? 0} leads, ${ms?.closed ?? 0} closed, ${ms?.booking ?? 0} bookings`;
      }).join("\n")
    : "None";

  return `You are an AI assistant for Carlton CRM helping a team leader manage their team.

## Team: ${team.name}
${team.description ? `Description: ${team.description}` : ""}
- **Leaders**: ${leaderNames}
- **Total Members**: ${Array.isArray(team.members) ? team.members.length : 0}
- **Status**: ${team.status}

## Team Lead Stats (Total: ${total})
${Object.entries(stats).map(([s, c]) => `  - ${s}: ${c}`).join("\n") || "  No leads yet."}

## Member Performance
${memberList || "  No members yet."}

## Your Role
- Help team leaders understand their team's performance
- Suggest strategies to improve conversion rates
- Identify top performers and underperformers
- Recommend how to distribute leads among members
- Provide coaching advice for specific situations
- Analyze trends and predict outcomes
- Be concise, data-driven, and actionable.`;
}

async function buildReportPrompt(): Promise<string> {
  // Aggregate overall stats for report context
  const [statusCounts, recentActivity] = await Promise.all([
    Lead.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const allStats: Record<string, number> = {};
  for (const s of statusCounts) allStats[s._id as string] = s.count as number;
  const total = Object.values(allStats).reduce((a, b) => a + b, 0);

  const last30: Record<string, number> = {};
  for (const s of recentActivity) last30[s._id as string] = s.count as number;
  const total30 = Object.values(last30).reduce((a, b) => a + b, 0);

  // Top performers
  const topUsers = await Lead.aggregate([
    { $match: { assignedTo: { $ne: null }, status: { $in: ["closed", "booking", "partialbooking"] } } },
    { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $project: { name: "$user.name", count: 1 } },
  ]);

  const topTeams = await Lead.aggregate([
    { $match: { team: { $ne: null }, status: { $in: ["closed", "booking", "partialbooking"] } } },
    { $group: { _id: "$team", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
    { $lookup: { from: "teams", localField: "_id", foreignField: "_id", as: "team" } },
    { $unwind: "$team" },
    { $project: { name: "$team.name", count: 1 } },
  ]);

  return `You are an AI analytics assistant for Carlton CRM. Help users understand their sales data and reports.

## Overall Lead Statistics (All Time, Total: ${total})
${Object.entries(allStats).map(([s, c]) => `  - ${s}: ${c} (${total > 0 ? ((c / total) * 100).toFixed(1) : 0}%)`).join("\n") || "  No data."}

## Last 30 Days (Total: ${total30})
${Object.entries(last30).map(([s, c]) => `  - ${s}: ${c}`).join("\n") || "  No data."}

## Top Performers (Closed/Bookings)
${topUsers.map((u, i) => `  ${i + 1}. ${u.name}: ${u.count} conversions`).join("\n") || "  No data."}

## Top Teams (Closed/Bookings)
${topTeams.map((t, i) => `  ${i + 1}. ${t.name}: ${t.count} conversions`).join("\n") || "  No data."}

## Your Role
- Analyze the sales data and identify trends
- Answer questions about conversion rates, performance, and metrics
- Suggest strategies to improve overall sales numbers
- Identify which statuses are bottlenecks
- Help interpret charts and rankings
- Provide actionable recommendations based on the data
- Be concise and data-driven.`;
}

// ── Shared chat handler ───────────────────────────────────────────────────────

async function handleChat(
  req: AuthenticatedRequest,
  res: Response,
  contextType: AiContextType,
  contextId: string,
  systemPromptFn: () => Promise<string>,
) {
  const { message } = req.body as { message?: string };
  const userId = req.user!.userId;

  if (!message?.trim()) { sendError(res, "Message is required", 400); return; }

  const model = getGemini();
  if (!model) { sendError(res, "AI not configured — add GEMINI_API_KEY to backend .env", 503); return; }

  let memory = await AiMemory.findOne({ contextType, contextId, user: userId });
  if (!memory) {
    memory = await AiMemory.create({ contextType, contextId, user: userId, messages: [] });
  }

  const systemInstruction = await systemPromptFn();

  // Build Gemini history (all messages except we'll send the latest separately)
  const history = memory.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // Start Gemini chat session
  const chat = model.startChat({
    systemInstruction: { role: "user", parts: [{ text: systemInstruction }] },
    history,
    generationConfig: { maxOutputTokens: 1024 },
  });

  const result = await chat.sendMessage(message.trim());
  const reply = result.response.text();

  // Save both turns to memory
  memory.messages.push({ role: "user", content: message.trim(), createdAt: new Date() });
  memory.messages.push({ role: "assistant", content: reply, createdAt: new Date() });

  if (memory.messages.length > MAX_MEMORY_MESSAGES) {
    memory.messages = memory.messages.slice(-MAX_MEMORY_MESSAGES);
  }

  await memory.save();

  sendSuccess(res, "OK", { reply, messages: memory.messages });
}

// ── Controllers ───────────────────────────────────────────────────────────────

/** POST /ai/chat/lead/:leadId */
export const chatWithLead = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { leadId } = req.params;
    await handleChat(req, res, "lead", leadId, () => buildLeadPrompt(leadId));
  } catch (err) {
    console.error("AI lead chat error:", err);
    sendError(res, "AI request failed", 500);
  }
};

/** POST /ai/chat/team/:teamId */
export const chatWithTeam = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { teamId } = req.params;
    await handleChat(req, res, "team", teamId, () => buildTeamPrompt(teamId));
  } catch (err) {
    console.error("AI team chat error:", err);
    sendError(res, "AI request failed", 500);
  }
};

/** POST /ai/chat/report */
export const chatWithReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await handleChat(req, res, "report", "global", buildReportPrompt);
  } catch (err) {
    console.error("AI report chat error:", err);
    sendError(res, "AI request failed", 500);
  }
};

/** GET /ai/memory/:contextType/:contextId */
export const getAiMemory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { contextType, contextId } = req.params;
    const userId = req.user!.userId;
    const memory = await AiMemory.findOne({ contextType, contextId, user: userId });
    sendSuccess(res, "OK", { messages: memory?.messages ?? [] });
  } catch {
    sendError(res, "Failed to load AI memory", 500);
  }
};

/** DELETE /ai/memory/:contextType/:contextId */
export const clearAiMemory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { contextType, contextId } = req.params;
    const userId = req.user!.userId;
    await AiMemory.findOneAndUpdate(
      { contextType, contextId, user: userId },
      { $set: { messages: [] } },
    );
    sendSuccess(res, "Conversation cleared");
  } catch {
    sendError(res, "Failed to clear AI memory", 500);
  }
};
