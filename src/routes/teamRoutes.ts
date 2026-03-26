import { Router } from "express";
import {
  createTeam,
  getTeams,
  getTeamById,
  getMyTeam,
  updateTeam,
  deleteTeam,
  getTeamLeads,
  getTeamMemberStats,
  autoAssignTeamLeads,
  assignLeadToMember,
  getTeamDashboard,
  getTeamLogs,
  bulkAssignTeamLeadsToMember,
  bulkTransferTeamLeads,
  bulkUpdateTeamLeadsStatus,
} from "../controllers/teamController.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";

const router = Router();

// All team routes require authentication
router.use(authenticate);

// ── CRUD ─────────────────────────────────────────────────────────────────────
router.get(   "/",     checkPermission("leads", "view"),   getTeams);
router.post(  "/",     checkPermission("leads", "create"), createTeam);
// /mine MUST come before /:id so Express doesn't treat "mine" as an ObjectId
router.get(   "/mine", checkPermission("leads", "view"),   getMyTeam);
router.get(   "/:id",  checkPermission("leads", "view"),   getTeamById);
router.put(   "/:id", checkPermission("leads", "edit"),   updateTeam);
router.delete("/:id", checkPermission("leads", "delete"), deleteTeam);

// ── Team leads & stats ────────────────────────────────────────────────────────
router.get( "/:id/dashboard",              checkPermission("leads", "view"), getTeamDashboard);
router.get( "/:id/leads",                  checkPermission("leads", "view"), getTeamLeads);
router.get( "/:id/member-stats",           checkPermission("leads", "view"), getTeamMemberStats);
router.get( "/:id/logs",                   checkPermission("leads", "view"), getTeamLogs);
router.post("/:id/auto-assign",            checkPermission("leads", "edit"), autoAssignTeamLeads);
router.patch("/:id/leads/:leadId/assign",  checkPermission("leads", "edit"), assignLeadToMember);

// ── Bulk team-lead operations ─────────────────────────────────────────────────
router.patch("/:id/leads/bulk/assign",   checkPermission("leads", "edit"), bulkAssignTeamLeadsToMember);
router.patch("/:id/leads/bulk/transfer", checkPermission("leads", "edit"), bulkTransferTeamLeads);
router.patch("/:id/leads/bulk/status",   checkPermission("leads", "edit"), bulkUpdateTeamLeadsStatus);

export default router;
