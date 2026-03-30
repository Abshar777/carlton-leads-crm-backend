import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  chatWithLead,
  chatWithTeam,
  chatWithReport,
  getAiMemory,
  clearAiMemory,
} from "../controllers/aiController.js";

const router = Router();

router.use(authenticate);

// ── Chat endpoints ────────────────────────────────────────────────────────────
router.post("/chat/lead/:leadId",   chatWithLead);
router.post("/chat/team/:teamId",   chatWithTeam);
router.post("/chat/report",         chatWithReport);

// ── Memory endpoints ──────────────────────────────────────────────────────────
router.get("/memory/:contextType/:contextId",    getAiMemory);
router.delete("/memory/:contextType/:contextId", clearAiMemory);

export default router;
