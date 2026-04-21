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
  getTeamUpdates,
  postTeamMessage,
  bulkAssignTeamLeadsToMember,
  bulkTransferTeamLeads,
  bulkUpdateTeamLeadsStatus,
  toggleMemberActive,
  getTeamMemberById,
  getTeamMemberLeads,
  getTeamRevenue,
  getTeamRevenueTimeline,
  getTeamReminders,
  getTeamSettings,
  updateTeamSettings,
} from "../controllers/teamController.js";
import { exportTeamPdf } from "../controllers/exportController.js";
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

// ── Bulk team-lead operations (must come BEFORE /:leadId routes) ──────────────
router.patch("/:id/leads/bulk/assign",   checkPermission("leads", "edit"), bulkAssignTeamLeadsToMember);
router.patch("/:id/leads/bulk/transfer", checkPermission("leads", "edit"), bulkTransferTeamLeads);
router.patch("/:id/leads/bulk/status",   checkPermission("leads", "edit"), bulkUpdateTeamLeadsStatus);

// ── Per-lead operations (parameterized — must come AFTER static /bulk routes) ─
router.patch("/:id/leads/:leadId/assign",  checkPermission("leads", "edit"), assignLeadToMember);

// ── Member active/inactive toggle (team-scoped, for auto-assignment) ─────────
router.patch("/:id/members/:memberId/toggle-active", checkPermission("leads", "edit"), toggleMemberActive);

// ── Member profile + leads (no users permission — access guarded in service) ──
router.get("/:teamId/members/:memberId",        getTeamMemberById);
router.get("/:teamId/members/:memberId/leads",  getTeamMemberLeads);

// ── Updates feed & team chat ──────────────────────────────────────────────────
router.get( "/:id/updates",  checkPermission("leads", "view"),   getTeamUpdates);
router.post("/:id/messages", checkPermission("leads", "view"),   postTeamMessage);

// ── Revenue analytics ─────────────────────────────────────────────────────────
router.get("/:id/revenue",          checkPermission("leads", "view"), getTeamRevenue);
router.get("/:id/revenue/timeline", checkPermission("leads", "view"), getTeamRevenueTimeline);

// ── Team reminders (team leader / admin) ──────────────────────────────────────
router.get("/:id/reminders", checkPermission("leads", "view"), getTeamReminders);

// ── Team settings ─────────────────────────────────────────────────────────────
router.get(  "/:id/settings", checkPermission("leads", "view"), getTeamSettings);
router.patch("/:id/settings", checkPermission("leads", "edit"), updateTeamSettings);

// ── Export ─────────────────────────────────────────────────────────────────────
router.get("/:id/export-pdf", checkPermission("leads", "view"), exportTeamPdf);

export default router;
