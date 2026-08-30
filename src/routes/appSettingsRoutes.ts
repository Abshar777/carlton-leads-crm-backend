import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { getAppSettings, updateAppSettings } from "../controllers/appSettingsController.js";

const router = Router();

router.use(authenticate);

router.get("/",     checkPermission("settings", "view"),   getAppSettings);
router.patch("/",   checkPermission("settings", "edit"),   updateAppSettings);

export default router;
