import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  getOverview,
  getTimeline,
  getUserRankings,
  getTeamRankings,
  getTeamSplit,
} from "../controllers/reportController.js";

const router = Router();

// All report routes require authentication + "reports" → "view" permission
router.use(authenticate);
router.use(checkPermission("reports", "view"));

router.get("/overview",    getOverview);
router.get("/timeline",    getTimeline);
router.get("/users",       getUserRankings);
router.get("/teams",       getTeamRankings);
router.get("/team-split",  getTeamSplit);

export default router;
