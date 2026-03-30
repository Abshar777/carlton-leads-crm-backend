import { Router } from "express";
import { getLeadsByUser, getUserLeadStats } from "../controllers/leadController.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";

const router = Router({ mergeParams: true });

// All routes require authentication
router.use(authenticate);

router.get("/:userId/leads", getLeadsByUser);
router.get("/:userId/lead-stats", getUserLeadStats);

export default router;
