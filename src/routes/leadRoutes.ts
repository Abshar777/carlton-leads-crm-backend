import { Router } from "express";
import multer from "multer";
import {
  uploadLeads,
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  updateLeadStatus,
  assignLead,
  assignLeadToTeam,
  transferLeadToTeam,
  deleteLead,
  getLeadsByUser,
  getUserLeadStats,
  autoAssignLeads,
  addNote,
  updateNote,
  deleteNote,
  bulkUpdateLeadStatus,
  bulkDeleteLeads,
  bulkAssignLeadsToTeam,
} from "../controllers/leadController.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";

const router = Router();

// Multer: memory storage, 10 MB, xlsx/xls/csv only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "application/csv",
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Only xlsx, xls, and csv files are allowed"));
    }
  },
});

router.use(authenticate);

// ─── Bulk / Special routes (must be before /:id) ──────────────────────────────
router.post("/upload",          checkPermission("leads", "create"), upload.single("file"), uploadLeads);
router.post("/auto-assign",     checkPermission("leads", "approve"), autoAssignLeads);
router.patch("/bulk/status",    checkPermission("leads", "edit"),   bulkUpdateLeadStatus);
router.delete("/bulk",          checkPermission("leads", "delete"), bulkDeleteLeads);
router.patch("/bulk/team",      checkPermission("leads", "edit"),   bulkAssignLeadsToTeam);

// ─── Lead CRUD ────────────────────────────────────────────────────────────────
router.post("/", checkPermission("leads", "create"), createLead);
router.get("/", checkPermission("leads", "view"), getLeads);
router.get("/:id", checkPermission("leads", "view"), getLeadById);
router.put("/:id", checkPermission("leads", "edit"), updateLead);
router.patch("/:id/status",   checkPermission("leads", "edit"), updateLeadStatus);
router.patch("/:id/assign",   checkPermission("leads", "edit"), assignLead);
router.patch("/:id/team",     checkPermission("leads", "edit"), assignLeadToTeam);
router.patch("/:id/transfer", checkPermission("leads", "edit"), transferLeadToTeam);
router.delete("/:id", checkPermission("leads", "delete"), deleteLead);

// ─── Notes (nested under lead) ────────────────────────────────────────────────
router.post("/:id/notes", checkPermission("leads", "edit"), addNote);
router.put("/:id/notes/:noteId", checkPermission("leads", "edit"), updateNote);
router.delete("/:id/notes/:noteId", checkPermission("leads", "edit"), deleteNote);

export default router;
