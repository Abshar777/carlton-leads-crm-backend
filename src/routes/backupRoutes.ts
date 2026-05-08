import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { getManifest, triggerBackup, restoreBackup } from "../controllers/backupController.js";

const router = Router();

// All backup routes are settings-level — Super Admin only in practice
router.get("/manifest", authenticate, checkPermission("settings", "view"), getManifest);
router.post("/run",     authenticate, checkPermission("settings", "edit"), triggerBackup);
router.post("/restore", authenticate, checkPermission("settings", "edit"), restoreBackup);

export default router;
