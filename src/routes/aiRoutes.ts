import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  chatWithLead,
  chatWithTeam,
  chatWithReport,
  chatWithSession,
  getAiModels,
  getAiMemory,
  clearAiMemory,
  listAiSessions,
  createAiSession,
  renameAiSession,
  deleteAiSession,
  getSessionMessages,
} from "../controllers/aiController.js";

const router = Router();

router.use(authenticate);

// ── Model info ────────────────────────────────────────────────────────────────
router.get("/models", getAiModels);

// ── Session management ────────────────────────────────────────────────────────
router.get("/sessions",                         listAiSessions);
router.post("/sessions",                        createAiSession);
router.get("/sessions/:sessionId/messages",     getSessionMessages);
router.patch("/sessions/:sessionId",            renameAiSession);
router.delete("/sessions/:sessionId",           deleteAiSession);

// ── Session-based chat (AI Agent page) ────────────────────────────────────────
router.post("/chat/session/:sessionId",         chatWithSession);

// ── Legacy chat endpoints (lead / team detail pages) ─────────────────────────
router.post("/chat/lead/:leadId",               chatWithLead);
router.post("/chat/team/:teamId",               chatWithTeam);
router.post("/chat/report",                     chatWithReport);

// ── Legacy memory endpoints ───────────────────────────────────────────────────
router.get("/memory/:contextType/:contextId",    getAiMemory);
router.delete("/memory/:contextType/:contextId", clearAiMemory);

export default router;
