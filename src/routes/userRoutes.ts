import { Router } from "express";
import {
  createUser,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
} from "../controllers/userController.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";

const router = Router();

// All user routes require authentication
router.use(authenticate);

router.get("/", checkPermission("users", "view"), getUsers);
router.post("/", checkPermission("users", "create"), createUser);
router.get("/:id", checkPermission("users", "view"), getUserById);
router.put("/:id", checkPermission("users", "edit"), updateUser);
router.delete("/:id", checkPermission("users", "delete"), deleteUser);

export default router;
