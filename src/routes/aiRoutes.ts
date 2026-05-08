import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
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
router.get("/models", checkPermission("ai-agent", "view"), getAiModels);

// ── Session management ────────────────────────────────────────────────────────
router.get("/sessions",                         checkPermission("ai-agent", "view"),   listAiSessions);
router.post("/sessions",                        checkPermission("ai-agent", "create"), createAiSession);
router.get("/sessions/:sessionId/messages",     checkPermission("ai-agent", "view"),   getSessionMessages);
router.patch("/sessions/:sessionId",            checkPermission("ai-agent", "edit"),   renameAiSession);
router.delete("/sessions/:sessionId",           checkPermission("ai-agent", "delete"), deleteAiSession);

// ── Session-based chat (AI Agent page) ────────────────────────────────────────
router.post("/chat/session/:sessionId",         checkPermission("ai-agent", "create"), chatWithSession);

// ── Legacy chat endpoints (lead / team detail pages) ─────────────────────────
router.post("/chat/lead/:leadId",               checkPermission("ai-agent", "create"), chatWithLead);
router.post("/chat/team/:teamId",               checkPermission("ai-agent", "create"), chatWithTeam);
router.post("/chat/report",                     checkPermission("ai-agent", "create"), chatWithReport);

// ── Legacy memory endpoints ───────────────────────────────────────────────────
router.get("/memory/:contextType/:contextId",    checkPermission("ai-agent", "view"),   getAiMemory);
router.delete("/memory/:contextType/:contextId", checkPermission("ai-agent", "delete"), clearAiMemory);

export default router;
