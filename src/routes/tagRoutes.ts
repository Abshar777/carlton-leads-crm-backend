import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { getAllTags, createTag, updateTag, deleteTag } from "../controllers/tagController.js";

const router = Router();

router.use(authenticate);

router.get("/",     checkPermission("settings", "view"),   getAllTags);
router.post("/",    checkPermission("settings", "create"), createTag);
router.put("/:id",  checkPermission("settings", "edit"),   updateTag);
router.delete("/:id", checkPermission("settings", "delete"), deleteTag);

export default router;
