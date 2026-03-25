import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  createCourse,
  getCourses,
  getAllCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
} from "../controllers/courseController.js";

const router = Router();

router.use(authenticate);

// All courses (dropdown, no pagination)
router.get("/all", getAllCourses);

// Paginated list
router.get("/", getCourses);

// Single course
router.get("/:id", getCourseById);

// Create
router.post("/", checkPermission("leads", "create"), createCourse);

// Update
router.put("/:id", checkPermission("leads", "edit"), updateCourse);

// Delete
router.delete("/:id", checkPermission("leads", "delete"), deleteCourse);

export default router;
