import { Router } from "express";
import { authenticateApiKey } from "../middleware/apiKeyAuth.js";
import { syncSheetLead, syncSheetLeadsBatch } from "../controllers/sheetsController.js";

const router = Router();

// All sheet routes require a valid x-api-key header
router.use(authenticateApiKey);

/**
 * POST /api/sheets/sync
 * Single-row sync — called by App Script onEdit / onChange triggers
 * Body: one row object with all 17 sheet columns
 */
router.post("/sync", syncSheetLead);

/**
 * POST /api/sheets/sync/batch
 * Batch sync — called once per execution to push all un-synced rows
 * Body: { rows: [ ...row objects ] }
 */
router.post("/sync/batch", syncSheetLeadsBatch);

export default router;
