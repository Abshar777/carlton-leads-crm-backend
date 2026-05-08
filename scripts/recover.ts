#!/usr/bin/env bun
/**
 * Carlton CRM — Backup Recovery CLI
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:  bun run recover
 *
 * Menu options:
 *   1. Latest          — most recent backup
 *   2. Yesterday       — last backup from yesterday
 *   3. This month      — first backup of current month
 *   4. Custom          — enter date/time: dd/mm/yyyy-hh:MM
 *   5. List all        — show every backup in the manifest
 */

import "dotenv/config";
import readline from "readline";
import fs from "fs";
import mongoose, { Types } from "mongoose";

import { connectDB }   from "../src/config/database.js";
import {
  MANIFEST_PATH,
  type BackupManifest,
  type ManifestEntry,
  type ManifestCollection,
} from "../src/services/backupService.js";

import { User }             from "../src/models/User.js";
import { Lead }             from "../src/models/Lead.js";
import { Team }             from "../src/models/Team.js";
import { Role }             from "../src/models/Role.js";
import { Course }           from "../src/models/Course.js";
import { AiMemory }         from "../src/models/AiMemory.js";
import { PushSubscription } from "../src/models/PushSubscription.js";
import { TeamMessage }      from "../src/models/TeamMessage.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

const MODEL_MAP: Record<string, mongoose.Model<any>> = {
  Users:             User,
  Leads:             Lead,
  Teams:             Team,
  Roles:             Role,
  Courses:           Course,
  AiMemories:        AiMemory,
  PushSubscriptions: PushSubscription,
  TeamMessages:      TeamMessage,
};

// ─── CLI helpers ──────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));
}

function line(char = "─", len = 54) {
  console.log(char.repeat(len));
}

function header() {
  console.clear();
  line("═");
  console.log("   Carlton CRM — Backup Recovery");
  line("═");
  console.log();
}

// ─── IST helpers ─────────────────────────────────────────────────────────────

/** Returns a Date representing midnight IST of the given offset day (0=today, -1=yesterday) */
function istDayBounds(offsetDays: number): { start: Date; end: Date } {
  const istNow  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const target  = new Date(istNow);
  target.setDate(target.getDate() + offsetDays);
  target.setHours(0, 0, 0, 0);

  const start = new Date(target.getTime() - 5.5 * 3600_000); // convert IST midnight → UTC
  const end   = new Date(start.getTime() + 24 * 3600_000);
  return { start, end };
}

/** Parse dd/mm/yyyy-hh:MM → Date (IST) */
function parseCustomDate(input: string): Date | null {
  const match = input.match(/^(\d{2})\/(\d{2})\/(\d{4})-(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, MM] = match;
  // Build as IST by appending +05:30
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${MM}:00+05:30`;
  const d   = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Return YYYYMM string in IST for a UTC timestamp */
function istYearMonth(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
           .replace("/", "-");
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

function loadManifest(): BackupManifest {
  if (!fs.existsSync(MANIFEST_PATH)) return { backups: [] };
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as BackupManifest;
}

function findLatest(m: BackupManifest): ManifestEntry | null {
  return m.backups.length ? m.backups[m.backups.length - 1] : null;
}

function findYesterday(m: BackupManifest): ManifestEntry | null {
  const { start, end } = istDayBounds(-1);
  const matches = m.backups.filter((b) => {
    const t = new Date(b.timestamp).getTime();
    return t >= start.getTime() && t < end.getTime();
  });
  return matches.length ? matches[matches.length - 1] : null;
}

function findThisMonthFirst(m: BackupManifest): ManifestEntry | null {
  const nowYM = istYearMonth(new Date().toISOString());
  const matches = m.backups.filter((b) => istYearMonth(b.timestamp) === nowYM);
  return matches.length ? matches[0] : null;
}

function findClosestToDate(m: BackupManifest, target: Date): ManifestEntry | null {
  if (!m.backups.length) return null;
  return m.backups.reduce((best, cur) => {
    const bestDiff = Math.abs(new Date(best.timestamp).getTime() - target.getTime());
    const curDiff  = Math.abs(new Date(cur.timestamp).getTime() - target.getTime());
    return curDiff < bestDiff ? cur : best;
  });
}

// ─── Telegram download ────────────────────────────────────────────────────────

async function downloadFromTelegram(fileId: string): Promise<any[]> {
  // Step 1: resolve file path
  const infoRes  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const infoJson = (await infoRes.json()) as { ok: boolean; result?: { file_path: string } };
  if (!infoJson.ok || !infoJson.result) throw new Error("Could not resolve file from Telegram");

  // Step 2: download
  const dlRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${infoJson.result.file_path}`);
  const text  = await dlRes.text();
  return JSON.parse(text) as any[];
}

// ─── ObjectId restoration ─────────────────────────────────────────────────────

/** Recursively converts 24-char hex strings back to ObjectId */
function restoreObjectIds(val: any): any {
  if (Array.isArray(val))             return val.map(restoreObjectIds);
  if (val && typeof val === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(val)) out[k] = restoreObjectIds(v);
    return out;
  }
  if (
    typeof val === "string" &&
    val.length === 24 &&
    /^[0-9a-fA-F]{24}$/.test(val)
  ) {
    return new Types.ObjectId(val);
  }
  return val;
}

// ─── Restore ─────────────────────────────────────────────────────────────────

async function restoreCollection(col: ManifestCollection): Promise<void> {
  process.stdout.write(`  Downloading ${col.name}...`);
  const raw  = await downloadFromTelegram(col.fileId);
  const docs = raw.map(restoreObjectIds);
  process.stdout.write(` ${docs.length} records. Restoring...`);

  const model = MODEL_MAP[col.name];
  if (!model) throw new Error(`No model found for collection: ${col.name}`);

  await model.deleteMany({});
  if (docs.length > 0) await model.collection.insertMany(docs, { ordered: false });
  console.log(" ✅");
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function printEntry(entry: ManifestEntry, idx?: number) {
  const prefix = idx !== undefined ? `  ${String(idx + 1).padStart(2, " ")}.` : "     ";
  console.log(`${prefix} ${entry.timestampIST}  (${entry.totalRecords} records, ${entry.collections.length} collections)`);
}

function printAllBackups(entries: ManifestEntry[]) {
  if (!entries.length) {
    console.log("  No backups found in manifest.");
    return;
  }
  console.log(`  ${"#".padEnd(4)} ${"Timestamp (IST)".padEnd(32)} Records`);
  line();
  entries.forEach((e, i) => printEntry(e, i));
}

// ─── Main menu ────────────────────────────────────────────────────────────────

async function selectBackup(manifest: BackupManifest): Promise<ManifestEntry | null> {
  const latest        = findLatest(manifest);
  const yesterday     = findYesterday(manifest);
  const thisMonthFirst = findThisMonthFirst(manifest);

  console.log("  Select a backup to restore:\n");
  console.log(`  1. Latest         ${latest        ? `— ${latest.timestampIST}`        : "— (no backups found)"}`);
  console.log(`  2. Yesterday      ${yesterday     ? `— ${yesterday.timestampIST}`     : "— (no backup from yesterday)"}`);
  console.log(`  3. This month     ${thisMonthFirst ? `— ${thisMonthFirst.timestampIST}` : "— (no backup this month)"}`);
  console.log("  4. Custom         — enter date/time: dd/mm/yyyy-hh:MM");
  console.log("  5. List all       — show every available backup");
  console.log("  0. Exit\n");

  const choice = await ask("  Select (0–5): ");

  switch (choice) {
    case "1":
      return latest ?? null;

    case "2":
      if (!yesterday) { console.log("\n  ⚠️  No backup found from yesterday."); return null; }
      return yesterday;

    case "3":
      if (!thisMonthFirst) { console.log("\n  ⚠️  No backup found for this month."); return null; }
      return thisMonthFirst;

    case "4": {
      const raw = await ask("  Enter date/time (dd/mm/yyyy-hh:MM): ");
      const target = parseCustomDate(raw);
      if (!target) {
        console.log("\n  ❌  Invalid format. Use dd/mm/yyyy-hh:MM  e.g. 08/05/2026-14:00");
        return null;
      }
      const found = findClosestToDate(manifest, target);
      if (!found) { console.log("\n  ⚠️  No backups in manifest."); return null; }
      console.log(`\n  Closest backup: ${found.timestampIST}`);
      return found;
    }

    case "5": {
      console.log();
      printAllBackups(manifest.backups);
      console.log();
      const idx = await ask("  Enter backup number to restore (or 0 to go back): ");
      if (idx === "0") return null;
      const n = parseInt(idx, 10);
      if (isNaN(n) || n < 1 || n > manifest.backups.length) {
        console.log("  ❌  Invalid selection.");
        return null;
      }
      return manifest.backups[n - 1];
    }

    case "0":
      return null;

    default:
      console.log("  ❌  Invalid choice.");
      return null;
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  header();

  if (!BOT_TOKEN) {
    console.log("❌  TELEGRAM_BOT_TOKEN not set in .env — cannot download backups.");
    rl.close();
    process.exit(1);
  }

  const manifest = loadManifest();

  if (!manifest.backups.length) {
    console.log("⚠️  No backups found in backup-manifest.json");
    console.log("   Run a backup first:  bun run backup\n");
    rl.close();
    process.exit(0);
  }

  // Select backup
  const entry = await selectBackup(manifest);
  if (!entry) {
    console.log("\n  Exiting.\n");
    rl.close();
    process.exit(0);
  }

  // Show what will be restored
  console.log(`\n  Selected backup: ${entry.timestampIST}\n`);
  console.log("  Collections to restore:");
  entry.collections.forEach((c) => {
    console.log(`    • ${c.name.padEnd(20)} ${c.count} records`);
  });

  console.log(`\n  ⚠️  WARNING: This will DELETE and REPLACE all data in the above collections!`);
  const confirm = await ask("  Type YES to confirm: ");

  if (confirm !== "YES") {
    console.log("\n  Cancelled.\n");
    rl.close();
    process.exit(0);
  }

  // Connect to MongoDB
  console.log("\n  Connecting to database...");
  await connectDB();
  console.log("  ✅ Connected\n");

  // Restore each collection
  console.log("  Restoring collections:");
  let passed = 0;
  let failed = 0;

  for (const col of entry.collections) {
    try {
      await restoreCollection(col);
      passed++;
    } catch (err) {
      console.log(` ❌  Failed: ${(err as Error).message}`);
      failed++;
    }
  }

  // Summary
  console.log();
  line();
  console.log(`  ✅ Restored ${passed}/${entry.collections.length} collections`);
  if (failed > 0) console.log(`  ❌ ${failed} failed — check errors above`);
  console.log(`  From: ${entry.timestampIST}`);
  line();
  console.log();

  rl.close();
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  rl.close();
  process.exit(1);
});
