import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  listWorkSchedules, createWorkSchedule, updateWorkSchedule, deleteWorkSchedule,
  getScheduleMembers, updateScheduleMembers,
} from "../controllers/workScheduleController.js";

const router = Router();
router.use(authenticate);

// Listing is open to any signed-in user; writes are Super Admin only, enforced
// in the controller.
router.get("/",       listWorkSchedules);
router.post("/",      createWorkSchedule);
router.put("/:id",    updateWorkSchedule);
router.delete("/:id", deleteWorkSchedule);

// Membership — who this schedule prompts. Only users on a schedule get call popups.
router.get("/:id/members", getScheduleMembers);
router.put("/:id/members", updateScheduleMembers);

export default router;
