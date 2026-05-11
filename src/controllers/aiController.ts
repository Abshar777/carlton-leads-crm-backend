import type { Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { AiMemory } from "../models/AiMemory.js";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { env } from "../config/env.js";
import type { AiContextType } from "../models/AiMemory.js";
import { emitToUser } from "../socket.js";
import mongoose from "mongoose";

const MAX_MEMORY_MESSAGES = 40;

// ── AI Provider helpers ───────────────────────────────────────────────────────

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${env.OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).some((m) => m.name.startsWith(env.OLLAMA_MODEL));
  } catch {
    return false;
  }
}

async function callOllama(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
): Promise<string> {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  const res = await fetch(`${env.OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.OLLAMA_MODEL, messages, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = json.choices?.[0]?.message?.content ?? "";
  if (!reply) throw new Error("Ollama returned an empty response");
  return reply;
}

async function callGemini(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const geminiHistory = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const chat = model.startChat({
    systemInstruction: { role: "user", parts: [{ text: systemPrompt }] },
    history: geminiHistory,
    generationConfig: { maxOutputTokens: 1024 },
  });

  try {
    const result = await chat.sendMessage(userMessage);
    return result.response.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429") || msg.includes("quota") || msg.includes("Too Many Requests")) {
      throw new Error(
        "Gemini free-tier quota exhausted. " +
        "Install Ollama for free unlimited AI: run `brew install ollama && ollama pull llama3.2` then restart the backend."
      );
    }
    throw err;
  }
}

async function callAI(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  userMessage: string,
): Promise<{ reply: string; provider: string }> {
  if (await isOllamaAvailable()) {
    try {
      const reply = await callOllama(systemPrompt, history, userMessage);
      return { reply, provider: `ollama:${env.OLLAMA_MODEL}` };
    } catch (err) {
      console.warn("Ollama failed, falling back to Gemini:", err);
    }
  }

  if (env.GEMINI_API_KEY) {
    const reply = await callGemini(systemPrompt, history, userMessage);
    return { reply, provider: "gemini:gemini-2.0-flash" };
  }

  throw new Error(
    "No AI provider available. " +
    "Install Ollama (free, local): run `brew install ollama && ollama pull llama3.2` — or add a valid GEMINI_API_KEY to backend/.env"
  );
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

  const statusCounts = await Lead.aggregate([
    { $match: { team: new mongoose.Types.ObjectId(teamId) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const stats: Record<string, number> = {};
  for (const s of statusCounts) stats[s._id as string] = s.count as number;
  const total = Object.values(stats).reduce((a, b) => a + b, 0);

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
  const [statusCounts, recentActivity] = await Promise.all([
    Lead.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
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

  const topUsers = await Lead.aggregate([
    { $match: { assignedTo: { $ne: null }, status: { $in: ["closed", "booking"] } } },
    { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
    { $sort: { count: -1 } }, { $limit: 5 },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $project: { name: "$user.name", count: 1 } },
  ]);

  const topTeams = await Lead.aggregate([
    { $match: { team: { $ne: null }, status: { $in: ["closed", "booking"] } } },
    { $group: { _id: "$team", count: { $sum: 1 } } },
    { $sort: { count: -1 } }, { $limit: 5 },
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

// ── Legacy shared chat handler (lead / team contexts) ─────────────────────────

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

  // Deterministic legacy key so old lead/team chats still work
  const sessionId = `${contextType}:${contextId}`;

  let memory = await AiMemory.findOne({ user: userId, sessionId });
  if (!memory) {
    memory = await AiMemory.create({ contextType, contextId, sessionId, sessionName: contextType, user: userId, messages: [] });
  }

  const systemPrompt = await systemPromptFn();
  const history = memory.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const { reply, provider } = await callAI(systemPrompt, history, message.trim());

  memory.messages.push({ role: "user",      content: message.trim(), createdAt: new Date() });
  memory.messages.push({ role: "assistant", content: reply,          createdAt: new Date() });

  if (memory.messages.length > MAX_MEMORY_MESSAGES) {
    memory.messages = memory.messages.slice(-MAX_MEMORY_MESSAGES);
  }
  await memory.save();

  sendSuccess(res, "OK", { reply, provider, messages: memory.messages });
}

// ── Session-based chat (AI Agent page) ────────────────────────────────────────

/** POST /ai/chat/session/:sessionId */
export const chatWithSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body as { message?: string };
    const userId = req.user!.userId;

    if (!message?.trim()) { sendError(res, "Message is required", 400); return; }

    const memory = await AiMemory.findOne({ user: userId, sessionId });
    if (!memory) { sendError(res, "Session not found", 404); return; }

    const systemPrompt = await buildReportPrompt();
    const history = memory.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const { reply, provider } = await callAI(systemPrompt, history, message.trim());

    const isFirstMessage = memory.messages.length === 0;
    const userMsg    = { role: "user"      as const, content: message.trim(), createdAt: new Date() };
    const assistantMsg = { role: "assistant" as const, content: reply,        createdAt: new Date() };

    memory.messages.push(userMsg);
    memory.messages.push(assistantMsg);

    // Auto-name session from first user message
    if (isFirstMessage && memory.sessionName === "New Chat") {
      memory.sessionName = message.trim().slice(0, 50) + (message.trim().length > 50 ? "…" : "");
    }

    if (memory.messages.length > MAX_MEMORY_MESSAGES) {
      memory.messages = memory.messages.slice(-MAX_MEMORY_MESSAGES);
    }
    await memory.save();

    // Push real-time event to all tabs open for this user
    emitToUser(userId, "ai:reply", {
      sessionId,
      message: assistantMsg,
      provider,
      sessionName: memory.sessionName,
    });

    sendSuccess(res, "OK", {
      reply,
      provider,
      messages:    memory.messages,
      sessionId,
      sessionName: memory.sessionName,
    });
  } catch (err) {
    console.error("AI session chat error:", err);
    sendError(res, (err as Error).message || "AI request failed", 503);
  }
};

// ── Session management ────────────────────────────────────────────────────────

/** GET /ai/sessions */
export const listAiSessions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { contextType, contextId } = req.query as { contextType?: string; contextId?: string };

    const query: Record<string, unknown> = { user: userId };
    if (contextType) query.contextType = contextType;
    if (contextId)   query.contextId   = contextId;
    // Exclude documents without sessionId and legacy deterministic sessions
    query.sessionId = { $exists: true, $ne: null, $not: /^(lead|team|report):/ };

    const sessions = await AiMemory.find(query)
      .select("sessionId sessionName contextType contextId messages updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    const result = sessions.map((s) => {
      const msgs = s.messages as Array<{ role: string; content: string; createdAt: Date }>;
      const last = msgs[msgs.length - 1];
      return {
        sessionId:     s.sessionId,
        sessionName:   s.sessionName,
        contextType:   s.contextType,
        contextId:     s.contextId,
        messageCount:  msgs.length,
        lastMessageAt: last ? last.createdAt : null,
        lastPreview:   last ? last.content.slice(0, 80) : null,
        updatedAt:     s.updatedAt,
      };
    });

    sendSuccess(res, "OK", result);
  } catch {
    sendError(res, "Failed to list sessions", 500);
  }
};

/** POST /ai/sessions */
export const createAiSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { contextType = "report", contextId = "global", sessionName = "New Chat" } =
      req.body as { contextType?: string; contextId?: string; sessionName?: string };

    const session = await AiMemory.create({
      contextType,
      contextId,
      sessionName,
      user:     userId,
      messages: [],
    });

    sendSuccess(res, "Session created", {
      sessionId:    session.sessionId,
      sessionName:  session.sessionName,
      contextType:  session.contextType,
      contextId:    session.contextId,
      messageCount: 0,
      lastMessageAt: null,
      lastPreview:   null,
      updatedAt:    session.updatedAt,
    }, 201);
  } catch (err) {
    console.error("createAiSession error:", err);
    sendError(res, (err as Error).message || "Failed to create session", 500);
  }
};

/** PATCH /ai/sessions/:sessionId */
export const renameAiSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { sessionId } = req.params;
    const { sessionName } = req.body as { sessionName?: string };

    if (!sessionName?.trim()) { sendError(res, "Session name is required", 400); return; }

    const updated = await AiMemory.findOneAndUpdate(
      { user: userId, sessionId },
      { $set: { sessionName: sessionName.trim() } },
      { new: true }
    ).select("sessionId sessionName");

    if (!updated) { sendError(res, "Session not found", 404); return; }
    sendSuccess(res, "Session renamed", { sessionId: updated.sessionId, sessionName: updated.sessionName });
  } catch {
    sendError(res, "Failed to rename session", 500);
  }
};

/** DELETE /ai/sessions/:sessionId */
export const deleteAiSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { sessionId } = req.params;

    const deleted = await AiMemory.findOneAndDelete({ user: userId, sessionId });
    if (!deleted) { sendError(res, "Session not found", 404); return; }
    sendSuccess(res, "Session deleted");
  } catch {
    sendError(res, "Failed to delete session", 500);
  }
};

/** GET /ai/sessions/:sessionId/messages */
export const getSessionMessages = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { sessionId } = req.params;

    const memory = await AiMemory.findOne({ user: userId, sessionId });
    if (!memory) { sendError(res, "Session not found", 404); return; }
    sendSuccess(res, "OK", { messages: memory.messages, sessionId: memory.sessionId, sessionName: memory.sessionName });
  } catch {
    sendError(res, "Failed to load session", 500);
  }
};

// ── Legacy controllers (lead / team / report) ─────────────────────────────────

export const chatWithLead = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { leadId } = req.params;
    await handleChat(req, res, "lead", leadId, () => buildLeadPrompt(leadId));
  } catch (err) {
    console.error("AI lead chat error:", err);
    sendError(res, (err as Error).message || "AI request failed", 503);
  }
};

export const chatWithTeam = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { teamId } = req.params;
    await handleChat(req, res, "team", teamId, () => buildTeamPrompt(teamId));
  } catch (err) {
    console.error("AI team chat error:", err);
    sendError(res, (err as Error).message || "AI request failed", 503);
  }
};

export const chatWithReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await handleChat(req, res, "report", "global", buildReportPrompt);
  } catch (err) {
    console.error("AI report chat error:", err);
    sendError(res, (err as Error).message || "AI request failed", 503);
  }
};

export const getAiModels = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const ollamaAvailable = await isOllamaAvailable();
    let ollamaModels: string[] = [];

    if (ollamaAvailable) {
      const r = await fetch(`${env.OLLAMA_BASE_URL}/api/tags`);
      const j = (await r.json()) as { models?: { name: string; size: number }[] };
      ollamaModels = (j.models ?? []).map((m) => m.name);
    }

    sendSuccess(res, "OK", {
      activeProvider: ollamaAvailable ? `ollama:${env.OLLAMA_MODEL}` : (env.GEMINI_API_KEY ? "gemini:gemini-2.0-flash" : "none"),
      ollama: { available: ollamaAvailable, baseUrl: env.OLLAMA_BASE_URL, activeModel: env.OLLAMA_MODEL, models: ollamaModels },
      gemini: { available: !!env.GEMINI_API_KEY, model: "gemini-2.0-flash" },
    });
  } catch {
    sendError(res, "Failed to fetch model info", 500);
  }
};

export const getAiMemory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { contextType, contextId } = req.params;
    const userId = req.user!.userId;
    const sessionId = `${contextType}:${contextId}`;
    const memory = await AiMemory.findOne({ user: userId, sessionId });
    sendSuccess(res, "OK", { messages: memory?.messages ?? [] });
  } catch {
    sendError(res, "Failed to load AI memory", 500);
  }
};

export const clearAiMemory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { contextType, contextId } = req.params;
    const userId = req.user!.userId;
    const sessionId = `${contextType}:${contextId}`;
    await AiMemory.findOneAndUpdate(
      { user: userId, sessionId },
      { $set: { messages: [] } },
    );
    sendSuccess(res, "Conversation cleared");
  } catch {
    sendError(res, "Failed to clear AI memory", 500);
  }
};
