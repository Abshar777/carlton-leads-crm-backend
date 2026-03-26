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

// Export routes  (?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  — both optional)
router.get("/export/excel",   exportExcel);
router.get("/export/pdf",     exportPdf);

export default router;
