import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  getMySession, respondToSession, endBreak, getNextLead, getOverview,
  submitCallOutcome, skipCallOutcome, confirmBreakReturn, extendBreak,
} from "../controllers/callAutomationController.js";

const router = Router();
router.use(authenticate);

// Every route here acts on the signed-in user's own session — no extra
// permission needed, and none of them can reach another user's data.
router.get("/overview",                getOverview);   // Super Admin only
router.get("/my-session",              getMySession);
router.get("/next-lead",               getNextLead);
router.post("/sessions/:id/respond",   respondToSession);
router.post("/break/end",              endBreak);
router.post("/break/return",           confirmBreakReturn);
router.post("/break/extend",           extendBreak);

// Call write-up — mandatory after "Call Next", or skipped with a reason.
router.post("/sessions/:id/outcome",      submitCallOutcome);
router.post("/sessions/:id/outcome/skip", skipCallOutcome);

export default router;
