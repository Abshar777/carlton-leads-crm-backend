import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  getOverview,
  getTimeline,
  getUserRankings,
  getTeamRankings,
  getTeamSplit,
  getRevenueOverview,
  getRevenueTimeline,
  getRevenueTeams,
} from "../controllers/reportController.js";
import { exportExcel, exportPdf } from "../controllers/exportController.js";

const router = Router();

// All report routes require authentication + "reports" → "view" permission
router.use(authenticate);
router.use(checkPermission("reports", "view"));

router.get("/overview",       getOverview);
router.get("/timeline",       getTimeline);
router.get("/users",          getUserRankings);
router.get("/teams",          getTeamRankings);
router.get("/team-split",     getTeamSplit);

// Revenue routes
router.get("/revenue/overview",  getRevenueOverview);
router.get("/revenue/timeline",  getRevenueTimeline);
router.get("/revenue/teams",     getRevenueTeams);

// Export routes  (?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  — both optional)
router.get("/export/excel",   exportExcel);
router.get("/export/pdf",     exportPdf);

export default router;
