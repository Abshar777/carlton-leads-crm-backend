import { Router } from "express";
import {
  createRole,
  getRoles,
  getRoleById,
  updateRole,
  deleteRole,
  getAllRolesSimple,
} from "../controllers/roleController.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";

const router = Router();

router.use(authenticate);

// Simple list for dropdowns (only view permission needed)
router.get("/all", checkPermission("roles", "view"), getAllRolesSimple);

router.get("/", checkPermission("roles", "view"), getRoles);
router.post("/", checkPermission("roles", "create"), createRole);
router.get("/:id", checkPermission("roles", "view"), getRoleById);
router.put("/:id", checkPermission("roles", "edit"), updateRole);
router.delete("/:id", checkPermission("roles", "delete"), deleteRole);

export default router;
