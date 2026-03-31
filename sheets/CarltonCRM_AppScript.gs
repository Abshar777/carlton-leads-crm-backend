/**
 * Carlton CRM — Google Sheets App Script
 * ════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 *   Watches multiple sheets for new / updated rows and pushes each
 *   row to the Carlton CRM backend as a Lead.
 *
 * SUPPORTED SHEETS
 *
 *   Sheet "Meta"  (Facebook / Instagram Ads)
 *   ─────────────────────────────────────────
 *   A  id            B  created_time   C  ad_id
 *   D  ad_name       E  adset_id       F  adset_name
 *   G  campaign_id   H  campaign_name  I  form_id
 *   J  form_name     K  is_organic     L  platform
 *   M  full_name     N  phone_number   O  email
 *   P  city          Q  lead_status
 *   R  CRM Sync      ← written by this script
 *
 *   Sheet "G ads & WhatsApp"  (WhatsApp / Google Ads)
 *   ─────────────────────────────────────────────────
 *   A  Name (full_name)
 *   B  Number (phone_number)
 *   C  Platform  (e.g. "WhatsApp", "Google")
 *   R  CRM Sync  ← written by this script (col 18)
 *
 * SETUP (do once)
 *   1. Open the sheet → Extensions → Apps Script → paste this file.
 *   2. Update CRM_API_URL and SHEETS_API_KEY below.
 *   3. Run setupTriggers() ONCE from the Run menu to install triggers.
 *   4. Authorize when prompted.
 *
 * TRIGGERS installed by setupTriggers():
 *   • onChange  → fires when the sheet content changes
 *   • Time-based (every 30 min) → safety net for missed changes
 * ════════════════════════════════════════════════════════════════════
 */

// ─── ⚙️  CONFIGURATION — edit these two values ──────────────────────────────

/** Your CRM server base URL (no trailing slash) */
var CRM_API_URL = "https://your-crm-domain.com/api";

/** Must match SHEETS_API_KEY in your backend .env */
var SHEETS_API_KEY = "carlton_sheets_key_change_in_production_2024";

// ─── Sheet names ──────────────────────────────────────────────────────────────

var SHEET_META      = "Meta";
var SHEET_WHATSAPP  = "G ads & WhatsApp";

// ─── Column mappings (0-based) ────────────────────────────────────────────────

/** Meta sheet — Facebook / Instagram Ads */
var META_COL = {
  ID:            0,   // A
  CREATED_TIME:  1,   // B
  AD_ID:         2,   // C
  AD_NAME:       3,   // D
  ADSET_ID:      4,   // E
  ADSET_NAME:    5,   // F
  CAMPAIGN_ID:   6,   // G
  CAMPAIGN_NAME: 7,   // H
  FORM_ID:       8,   // I
  FORM_NAME:     9,   // J
  IS_ORGANIC:    10,  // K
  PLATFORM:      11,  // L
  FULL_NAME:     12,  // M
  PHONE_NUMBER:  13,  // N
  EMAIL:         14,  // O
  CITY:          15,  // P
  LEAD_STATUS:   16,  // Q
  CRM_SYNC:      17,  // R
};

/** G ads & WhatsApp sheet */
var WA_COL = {
  FULL_NAME:    0,   // A  (Name)
  PHONE_NUMBER: 1,   // B  (Number)
  PLATFORM:     2,   // C  (Platform)
  CRM_SYNC:     17,  // R  (same column position as Meta)
};

var SYNC_STATUS = {
  PENDING:   "PENDING",
  SYNCED:    "✅ SYNCED",
  DUPLICATE: "⚠️ DUPLICATE",
  ERROR:     "❌ ERROR",
  SKIPPED:   "— SKIPPED",
};

// ─── Main entry points ────────────────────────────────────────────────────────

/**
 * Called automatically by the onChange trigger.
 * Processes pending rows in ALL supported sheets.
 */
function onSheetChange(e) {
  try {
    syncPendingRows();
  } catch (err) {
    Logger.log("onSheetChange error: " + err.toString());
  }
}

/**
 * Called by the time-based trigger (every 30 min).
 */
function scheduledSync() {
  try {
    syncPendingRows();
  } catch (err) {
    Logger.log("scheduledSync error: " + err.toString());
  }
}

/**
 * Manually sync ALL rows in ALL supported sheets regardless of sync status.
 */
function syncAllRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  syncAllRowsInSheet(ss, SHEET_META);
  syncAllRowsInSheet(ss, SHEET_WHATSAPP);
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

/**
 * Finds and syncs pending rows across all supported sheets.
 */
function syncPendingRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  syncPendingInSheet(ss, SHEET_META);
  syncPendingInSheet(ss, SHEET_WHATSAPP);
}

/**
 * Syncs pending rows for a specific sheet by name.
 * Silently skips if the sheet doesn't exist.
 */
function syncPendingInSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log("Sheet not found, skipping: " + sheetName);
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  ensureSyncColumn(sheet, getCrmSyncCol(sheetName));

  var data  = sheet.getDataRange().getValues();
  var batch = [];
  var syncColIdx = getCrmSyncCol(sheetName);

  for (var i = 1; i < data.length; i++) {
    var row        = data[i];
    var syncStatus = String(row[syncColIdx] || "").trim();
    var nameVal    = String(row[getNameCol(sheetName)] || "").trim();
    var phoneVal   = String(row[getPhoneCol(sheetName)] || "").trim();

    if (!nameVal || !phoneVal) continue;
    if (syncStatus === SYNC_STATUS.SYNCED || syncStatus === SYNC_STATUS.DUPLICATE) continue;

    batch.push({ rowIndex: i + 1, data: buildPayload(row, sheetName) });
  }

  if (batch.length === 0) {
    Logger.log("[" + sheetName + "] All rows already synced.");
    return;
  }

  Logger.log("[" + sheetName + "] Syncing " + batch.length + " pending row(s)...");
  processBatch(sheet, batch, syncColIdx);
}

/**
 * Syncs ALL rows for a specific sheet (full import / re-sync).
 */
function syncAllRowsInSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("[" + sheetName + "] No data rows found.");
    return;
  }

  var syncColIdx = getCrmSyncCol(sheetName);
  ensureSyncColumn(sheet, syncColIdx);

  var data  = sheet.getDataRange().getValues();
  var batch = [];

  for (var i = 1; i < data.length; i++) {
    var row      = data[i];
    var nameVal  = String(row[getNameCol(sheetName)] || "").trim();
    var phoneVal = String(row[getPhoneCol(sheetName)] || "").trim();
    if (!nameVal || !phoneVal) continue;
    batch.push({ rowIndex: i + 1, data: buildPayload(row, sheetName) });
  }

  if (batch.length === 0) {
    Logger.log("[" + sheetName + "] No valid rows to sync.");
    return;
  }

  processBatch(sheet, batch, syncColIdx);
}

/**
 * Sends a batch of rows to the CRM batch endpoint.
 * Falls back to individual sync if batch fails.
 */
function processBatch(sheet, batch, syncColIdx) {
  var rows     = batch.map(function(item) { return item.data; });
  var response = callApi("/sheets/sync/batch", { rows: rows });

  if (response && response.success && response.data && response.data.results) {
    var results = response.data.results;

    for (var i = 0; i < results.length; i++) {
      var result   = results[i];
      var rowIndex = batch[result.index].rowIndex;
      var syncCell = sheet.getRange(rowIndex, syncColIdx + 1);

      if (result.status === "created") {
        syncCell.setValue(SYNC_STATUS.SYNCED);
        syncCell.setBackground("#d9ead3");
        syncCell.setNote("CRM Lead ID: " + result.leadId + "\nSynced at: " + new Date().toISOString());
      } else if (result.status === "duplicate") {
        syncCell.setValue(SYNC_STATUS.DUPLICATE);
        syncCell.setBackground("#fff2cc");
        syncCell.setNote("Already exists in CRM\nLead ID: " + result.leadId);
      } else if (result.status === "invalid") {
        syncCell.setValue(SYNC_STATUS.ERROR);
        syncCell.setBackground("#f4cccc");
        syncCell.setNote("Validation error:\n" + (result.reason || "Unknown"));
      }
    }

    Logger.log(
      "Batch result — created: " + response.data.summary.created +
      ", duplicate: " + response.data.summary.duplicate +
      ", invalid: " + response.data.summary.invalid
    );
  } else {
    Logger.log("Batch call failed, falling back to individual sync...");
    for (var j = 0; j < batch.length; j++) {
      syncSingleRow(sheet, batch[j].rowIndex, batch[j].data, syncColIdx);
    }
  }
}

/**
 * Syncs one row individually (fallback when batch fails).
 */
function syncSingleRow(sheet, rowIndex, payload, syncColIdx) {
  var syncCell = sheet.getRange(rowIndex, syncColIdx + 1);
  syncCell.setValue(SYNC_STATUS.PENDING);

  var response = callApi("/sheets/sync", payload);

  if (!response) {
    syncCell.setValue(SYNC_STATUS.ERROR);
    syncCell.setBackground("#f4cccc");
    syncCell.setNote("Network error or server unreachable\n" + new Date().toISOString());
    return;
  }

  if (response.success) {
    if (response.data && response.data.duplicate) {
      syncCell.setValue(SYNC_STATUS.DUPLICATE);
      syncCell.setBackground("#fff2cc");
      syncCell.setNote("Already exists in CRM\nLead ID: " + response.data.leadId);
    } else {
      syncCell.setValue(SYNC_STATUS.SYNCED);
      syncCell.setBackground("#d9ead3");
      syncCell.setNote("CRM Lead ID: " + (response.data && response.data.leadId) + "\nSynced at: " + new Date().toISOString());
    }
  } else {
    syncCell.setValue(SYNC_STATUS.ERROR);
    syncCell.setBackground("#f4cccc");
    syncCell.setNote("Error: " + (response.message || "Unknown error") + "\n" + new Date().toISOString());
  }
}

// ─── Payload builders ─────────────────────────────────────────────────────────

/**
 * Builds the JSON payload for a row based on which sheet it came from.
 */
function buildPayload(row, sheetName) {
  if (sheetName === SHEET_WHATSAPP) {
    return buildWhatsAppPayload(row);
  }
  return buildMetaPayload(row);
}

/**
 * Payload for Meta / Facebook Ads sheet rows.
 */
function buildMetaPayload(row) {
  return {
    id:            String(row[META_COL.ID]            || "").trim() || undefined,
    created_time:  String(row[META_COL.CREATED_TIME]  || "").trim() || undefined,
    ad_id:         String(row[META_COL.AD_ID]         || "").trim() || undefined,
    ad_name:       String(row[META_COL.AD_NAME]       || "").trim() || undefined,
    adset_id:      String(row[META_COL.ADSET_ID]      || "").trim() || undefined,
    adset_name:    String(row[META_COL.ADSET_NAME]    || "").trim() || undefined,
    campaign_id:   String(row[META_COL.CAMPAIGN_ID]   || "").trim() || undefined,
    campaign_name: String(row[META_COL.CAMPAIGN_NAME] || "").trim() || undefined,
    form_id:       String(row[META_COL.FORM_ID]       || "").trim() || undefined,
    form_name:     String(row[META_COL.FORM_NAME]     || "").trim() || undefined,
    is_organic:    String(row[META_COL.IS_ORGANIC]    || "").trim() || undefined,
    platform:      String(row[META_COL.PLATFORM]      || "").trim() || undefined,
    full_name:     String(row[META_COL.FULL_NAME]     || "").trim(),
    phone_number:  String(row[META_COL.PHONE_NUMBER]  || "").trim(),
    email:         String(row[META_COL.EMAIL]         || "").trim() || undefined,
    city:          String(row[META_COL.CITY]          || "").trim() || undefined,
    lead_status:   String(row[META_COL.LEAD_STATUS]   || "").trim() || undefined,
  };
}

/**
 * Payload for G ads & WhatsApp sheet rows.
 */
function buildWhatsAppPayload(row) {
  var platform = String(row[WA_COL.PLATFORM] || "WhatsApp").trim();
  return {
    full_name:    String(row[WA_COL.FULL_NAME]    || "").trim(),
    phone_number: String(row[WA_COL.PHONE_NUMBER] || "").trim(),
    platform:     platform,
  };
}

// ─── Column index helpers ─────────────────────────────────────────────────────

function getCrmSyncCol(sheetName) {
  if (sheetName === SHEET_WHATSAPP) return WA_COL.CRM_SYNC;
  return META_COL.CRM_SYNC;
}

function getNameCol(sheetName) {
  if (sheetName === SHEET_WHATSAPP) return WA_COL.FULL_NAME;
  return META_COL.FULL_NAME;
}

function getPhoneCol(sheetName) {
  if (sheetName === SHEET_WHATSAPP) return WA_COL.PHONE_NUMBER;
  return META_COL.PHONE_NUMBER;
}

// ─── API helper ───────────────────────────────────────────────────────────────

/**
 * Makes an authenticated POST request to the CRM API.
 * Returns the parsed JSON response, or null on network failure.
 */
function callApi(path, payload) {
  var url = CRM_API_URL + path;

  var options = {
    method:             "post",
    contentType:        "application/json",
    headers:            { "x-api-key": SHEETS_API_KEY },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    var response   = UrlFetchApp.fetch(url, options);
    var statusCode = response.getResponseCode();
    var body       = response.getContentText();

    Logger.log("API " + path + " → HTTP " + statusCode + " | " + body.substring(0, 200));

    return JSON.parse(body);
  } catch (err) {
    Logger.log("callApi error (" + path + "): " + err.toString());
    return null;
  }
}

/**
 * Ensures the CRM Sync column has a header.
 * Safe to call repeatedly — only writes if the cell is empty.
 */
function ensureSyncColumn(sheet, syncColIdx) {
  var headerCell = sheet.getRange(1, syncColIdx + 1);
  if (!headerCell.getValue()) {
    headerCell.setValue("CRM Sync");
    headerCell.setFontWeight("bold");
    headerCell.setBackground("#cfe2f3");
    sheet.setColumnWidth(syncColIdx + 1, 140);
  }
}

// ─── One-time setup ───────────────────────────────────────────────────────────

/**
 * Run this ONCE from Extensions → Apps Script → Run → setupTriggers
 * to install the onChange and time-based triggers.
 */
function setupTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Remove any existing triggers to avoid duplicates
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    ScriptApp.deleteTrigger(existing[i]);
  }

  // onChange trigger — fires when rows are added/deleted programmatically
  ScriptApp.newTrigger("onSheetChange")
    .forSpreadsheet(ss)
    .onChange()
    .create();

  // Time-based safety net — every 30 minutes
  ScriptApp.newTrigger("scheduledSync")
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log("✅ Triggers installed: onChange + every 30 minutes");
  SpreadsheetApp.getUi().alert(
    "✅ Triggers installed successfully!\n\n" +
    "onChange: fires when rows are added\n" +
    "Scheduled: every 30 minutes\n\n" +
    "Watching sheets:\n• " + SHEET_META + "\n• " + SHEET_WHATSAPP
  );
}

/**
 * Removes all triggers (cleanup / reset).
 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log("All triggers removed.");
}

/**
 * Test function — run this first to verify your API key and URL work.
 */
function testConnection() {
  var testPayload = {
    full_name:    "Test Lead",
    phone_number: "0000000000",
    platform:     "WhatsApp",
  };

  var response = callApi("/sheets/sync", testPayload);

  if (response && response.success) {
    SpreadsheetApp.getUi().alert(
      "✅ Connection successful!\n\n" +
      "Server response: " + response.message + "\n" +
      "Lead ID: " + (response.data && response.data.leadId ? response.data.leadId : "N/A (duplicate or test)")
    );
  } else {
    SpreadsheetApp.getUi().alert(
      "❌ Connection failed!\n\n" +
      "Response: " + JSON.stringify(response) + "\n\n" +
      "Check:\n• CRM_API_URL is correct\n• SHEETS_API_KEY matches your .env\n• Server is running"
    );
  }
}

/**
 * Adds a custom menu to the sheet for easy access.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🚀 Carlton CRM")
    .addItem("Sync pending rows (all sheets)", "syncPendingRows")
    .addItem("Sync ALL rows — full import",    "syncAllRows")
    .addSeparator()
    .addItem("Test connection",  "testConnection")
    .addItem("Setup triggers",   "setupTriggers")
    .addItem("Remove triggers",  "removeTriggers")
    .addToUi();
}
