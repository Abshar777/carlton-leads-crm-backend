/**
 * Carlton CRM — Google Sheets App Script
 * ════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 *   Watches the Facebook Lead Ads sheet for new / updated rows and
 *   pushes each row to the Carlton CRM backend as a Lead.
 *
 * SHEET COLUMNS (must match this exact order in row 1):
 *   A  id            B  created_time   C  ad_id
 *   D  ad_name       E  adset_id       F  adset_name
 *   G  campaign_id   H  campaign_name  I  form_id
 *   J  form_name     K  is_organic     L  platform
 *   M  full_name     N  phone_number   O  email
 *   P  city          Q  lead_status
 *   R  CRM Sync      ← Added automatically by this script
 *
 * SETUP (do once)
 *   1. Open the sheet → Extensions → Apps Script → paste this file.
 *   2. Update CRM_API_URL and SHEETS_API_KEY below.
 *   3. Run setupTriggers() ONCE from the Run menu to install triggers.
 *   4. Authorize when prompted.
 *
 * TRIGGERS installed by setupTriggers():
 *   • onChange  → fires when the sheet content changes (new rows added
 *                 by Facebook Lead Ads integration or manually)
 *   • Time-based (every 30 min) → safety net for missed changes
 * ════════════════════════════════════════════════════════════════════
 */

// ─── ⚙️  CONFIGURATION — edit these two values ──────────────────────────────

/** Your CRM server base URL (no trailing slash) */
var CRM_API_URL = "https://your-crm-domain.com/api";

/** Must match SHEETS_API_KEY in your backend .env */
var SHEETS_API_KEY = "carlton_sheets_key_change_in_production_2024";

// ─── Column indices (0-based, matching the sheet order above) ────────────────

var COL = {
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
  CRM_SYNC:      17,  // R  ← written by this script
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
 * Processes all rows that haven't been synced yet.
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
 * Same as onSheetChange — ensures nothing is missed.
 */
function scheduledSync() {
  try {
    syncPendingRows();
  } catch (err) {
    Logger.log("scheduledSync error: " + err.toString());
  }
}

/**
 * Manually sync ALL rows regardless of sync status.
 * Run this once from the Run menu to do a full historical import.
 */
function syncAllRows() {
  var sheet    = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow  = sheet.getLastRow();

  if (lastRow < 2) {
    Logger.log("No data rows found.");
    return;
  }

  ensureSyncColumn(sheet);

  var data  = sheet.getDataRange().getValues();
  var batch = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!String(row[COL.FULL_NAME]).trim() || !String(row[COL.PHONE_NUMBER]).trim()) {
      continue; // skip empty rows
    }
    batch.push({ rowIndex: i + 1, data: buildRowPayload(row) });
  }

  if (batch.length === 0) {
    Logger.log("No valid rows to sync.");
    return;
  }

  processBatch(sheet, batch);
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

/**
 * Finds rows where CRM Sync column is blank or PENDING, then syncs them.
 */
function syncPendingRows() {
  var sheet    = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow  = sheet.getLastRow();

  if (lastRow < 2) return;

  ensureSyncColumn(sheet);

  var data     = sheet.getDataRange().getValues();
  var batch    = [];

  for (var i = 1; i < data.length; i++) {
    var row        = data[i];
    var syncStatus = String(row[COL.CRM_SYNC] || "").trim();
    var name       = String(row[COL.FULL_NAME] || "").trim();
    var phone      = String(row[COL.PHONE_NUMBER] || "").trim();

    // Skip rows that are already synced or have no data
    if (!name || !phone) continue;
    if (syncStatus === SYNC_STATUS.SYNCED || syncStatus === SYNC_STATUS.DUPLICATE) continue;

    batch.push({ rowIndex: i + 1, data: buildRowPayload(row) });
  }

  if (batch.length === 0) {
    Logger.log("All rows already synced.");
    return;
  }

  Logger.log("Syncing " + batch.length + " pending row(s)...");
  processBatch(sheet, batch);
}

/**
 * Sends a batch of rows to the CRM batch endpoint.
 * Falls back to individual sync if batch fails.
 */
function processBatch(sheet, batch) {
  var rows = batch.map(function(item) { return item.data; });

  var response = callApi("/sheets/sync/batch", { rows: rows });

  if (response && response.success && response.data && response.data.results) {
    var results = response.data.results;

    for (var i = 0; i < results.length; i++) {
      var result    = results[i];
      var rowIndex  = batch[result.index].rowIndex;
      var syncCell  = sheet.getRange(rowIndex, COL.CRM_SYNC + 1);

      if (result.status === "created") {
        syncCell.setValue(SYNC_STATUS.SYNCED);
        syncCell.setBackground("#d9ead3");  // light green
        syncCell.setNote("CRM Lead ID: " + result.leadId + "\nSynced at: " + new Date().toISOString());
      } else if (result.status === "duplicate") {
        syncCell.setValue(SYNC_STATUS.DUPLICATE);
        syncCell.setBackground("#fff2cc");  // light yellow
        syncCell.setNote("Already exists in CRM\nLead ID: " + result.leadId);
      } else if (result.status === "invalid") {
        syncCell.setValue(SYNC_STATUS.ERROR);
        syncCell.setBackground("#f4cccc");  // light red
        syncCell.setNote("Validation error:\n" + (result.reason || "Unknown"));
      }
    }

    Logger.log(
      "Batch result — created: " + response.data.summary.created +
      ", duplicate: " + response.data.summary.duplicate +
      ", invalid: " + response.data.summary.invalid
    );
  } else {
    // Batch call failed — fall back to row-by-row
    Logger.log("Batch call failed, falling back to individual sync...");
    for (var j = 0; j < batch.length; j++) {
      syncSingleRow(sheet, batch[j].rowIndex, batch[j].data);
    }
  }
}

/**
 * Syncs one row individually (fallback when batch fails).
 */
function syncSingleRow(sheet, rowIndex, payload) {
  var syncCell = sheet.getRange(rowIndex, COL.CRM_SYNC + 1);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds the JSON payload object from a sheet row array.
 */
function buildRowPayload(row) {
  return {
    id:            String(row[COL.ID]            || "").trim() || undefined,
    created_time:  String(row[COL.CREATED_TIME]  || "").trim() || undefined,
    ad_id:         String(row[COL.AD_ID]         || "").trim() || undefined,
    ad_name:       String(row[COL.AD_NAME]       || "").trim() || undefined,
    adset_id:      String(row[COL.ADSET_ID]      || "").trim() || undefined,
    adset_name:    String(row[COL.ADSET_NAME]    || "").trim() || undefined,
    campaign_id:   String(row[COL.CAMPAIGN_ID]   || "").trim() || undefined,
    campaign_name: String(row[COL.CAMPAIGN_NAME] || "").trim() || undefined,
    form_id:       String(row[COL.FORM_ID]       || "").trim() || undefined,
    form_name:     String(row[COL.FORM_NAME]     || "").trim() || undefined,
    is_organic:    String(row[COL.IS_ORGANIC]    || "").trim() || undefined,
    platform:      String(row[COL.PLATFORM]      || "").trim() || undefined,
    full_name:     String(row[COL.FULL_NAME]     || "").trim(),
    phone_number:  String(row[COL.PHONE_NUMBER]  || "").trim(),
    email:         String(row[COL.EMAIL]         || "").trim() || undefined,
    city:          String(row[COL.CITY]          || "").trim() || undefined,
    lead_status:   String(row[COL.LEAD_STATUS]   || "").trim() || undefined,
  };
}

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
 * Ensures column R has the header "CRM Sync".
 * Safe to call repeatedly — only writes if the cell is empty.
 */
function ensureSyncColumn(sheet) {
  var headerCell = sheet.getRange(1, COL.CRM_SYNC + 1);
  if (!headerCell.getValue()) {
    headerCell.setValue("CRM Sync");
    headerCell.setFontWeight("bold");
    headerCell.setBackground("#cfe2f3");
    sheet.setColumnWidth(COL.CRM_SYNC + 1, 140);
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
  SpreadsheetApp.getUi().alert("✅ Triggers installed successfully!\n\nonChange: fires when rows are added\nScheduled: every 30 minutes\n\nThe script will now auto-sync new leads to Carlton CRM.");
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
    email:        "test@carltoncrm.test",
    platform:     "ig",
    city:         "Test City",
    campaign_name:"Test Campaign",
    lead_status:  "TEST",
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
    .addItem("Sync pending rows", "syncPendingRows")
    .addItem("Sync ALL rows (full import)", "syncAllRows")
    .addSeparator()
    .addItem("Test connection", "testConnection")
    .addItem("Setup triggers", "setupTriggers")
    .addItem("Remove triggers", "removeTriggers")
    .addToUi();
}
