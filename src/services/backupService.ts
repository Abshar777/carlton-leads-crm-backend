/**
 * Backup Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Exports all MongoDB collections to JSON and sends them to a Telegram group.
 *
 * Schedule: 2:00 AM IST and 2:00 PM IST daily
 * No external cron/axios/form-data library — uses Bun built-ins only.
 *
 * Collections backed up:
 *   Users, Leads, Teams, Roles, Courses,
 *   AiMemories, PushSubscriptions, TeamMessages
 */

import fs from "fs";
import path from "path";
import { Types } from "mongoose";

import { User }             from "../models/User.js";
import { Lead }             from "../models/Lead.js";
import { Team }             from "../models/Team.js";
import { Role }             from "../models/Role.js";
import { Course }           from "../models/Course.js";
import { AiMemory }         from "../models/AiMemory.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { TeamMessage }      from "../models/TeamMessage.js";

// ─── Manifest Types ───────────────────────────────────────────────────────────

export interface ManifestCollection {
  name:   string;
  count:  number;
  fileId: string; // Telegram file_id — used by recover script to download
}

export interface ManifestEntry {
  id:           string; // ISO UTC — unique key
  timestamp:    string; // ISO UTC — for sorting / filtering
  timestampIST: string; // human-readable IST label
  totalRecords: number;
  collections:  ManifestCollection[];
}

export interface BackupManifest {
  backups: ManifestEntry[];
}

export const MANIFEST_PATH = path.resolve("backup-manifest.json");

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID   ?? "";
const BACKUP_DIR = path.resolve("backups");

const COLLECTIONS = [
  { model: User,             name: "Users"             },
  { model: Lead,             name: "Leads"             },
  { model: Team,             name: "Teams"             },
  { model: Role,             name: "Roles"             },
  { model: Course,           name: "Courses"           },
  { model: AiMemory,         name: "AiMemories"        },
  { model: PushSubscription, name: "PushSubscriptions" },
  { model: TeamMessage,      name: "TeamMessages"      },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowIST(): string {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

async function exportToJson(model: any, name: string): Promise<string> {
  const data     = await model.find().lean();
  const filePath = path.join(BACKUP_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}

async function sendFileToTelegram(filePath: string, caption: string): Promise<string> {
  const url        = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const fileBuffer = fs.readFileSync(filePath);
  const blob       = new Blob([fileBuffer], { type: "application/json" });

  const form = new FormData();
  form.append("chat_id",  CHAT_ID);
  form.append("caption",  caption);
  form.append("document", blob, path.basename(filePath));

  const res  = await fetch(url, { method: "POST", body: form });
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { document?: { file_id: string } };
  };
  if (!json.ok) throw new Error(`Telegram error: ${json.description}`);
  return json.result?.document?.file_id ?? "";
}

async function sendMessage(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
}

// ─── Main Backup ──────────────────────────────────────────────────────────────

export async function runBackup(): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("⚠️  Backup skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env");
    return;
  }

  console.log("🗄️  Starting backup...");

  // Ensure backup directory exists before any export
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const now       = new Date();
  const timestamp = nowIST();
  const manifestCollections: ManifestCollection[] = [];
  const results: { name: string; count: number; status: "✅" | "❌" }[] = [];

  // Header message
  await sendMessage(
    `📦 <b>Carlton CRM Backup</b>\n🕐 ${timestamp}\n\nStarting backup of ${COLLECTIONS.length} collections...`
  );

  for (const { model, name } of COLLECTIONS) {
    let filePath: string | null = null;
    try {
      filePath      = await exportToJson(model, name);
      const data    = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown[];
      const count   = data.length;
      const fileId  = await sendFileToTelegram(filePath, `📄 ${name} — ${count} records\n🕐 ${timestamp}`);

      results.push({ name, count, status: "✅" });
      manifestCollections.push({ name, count, fileId });
      console.log(`  ✅ ${name}: ${count} records sent`);
    } catch (err) {
      results.push({ name, count: 0, status: "❌" });
      console.error(`  ❌ ${name} failed:`, err);
    } finally {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  // Write manifest entry (only collections that succeeded)
  if (manifestCollections.length > 0) {
    const manifest: BackupManifest = fs.existsSync(MANIFEST_PATH)
      ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"))
      : { backups: [] };

    manifest.backups.push({
      id:           now.toISOString(),
      timestamp:    now.toISOString(),
      timestampIST: timestamp,
      totalRecords: manifestCollections.reduce((s, c) => s + c.count, 0),
      collections:  manifestCollections,
    });

    // Keep only the last 60 entries (~1 month of twice-daily backups)
    if (manifest.backups.length > 60) manifest.backups = manifest.backups.slice(-60);
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
  }

  // Summary message
  const passed  = results.filter((r) => r.status === "✅").length;
  const failed  = results.filter((r) => r.status === "❌").length;
  const summary = results
    .map((r) => `${r.status} ${r.name}${r.count ? ` (${r.count})` : ""}`)
    .join("\n");

  await sendMessage(
    `📊 <b>Backup Complete</b>\n🕐 ${timestamp}\n\n${summary}\n\n` +
    `<b>${passed}/${COLLECTIONS.length} collections backed up</b>` +
    (failed > 0 ? `\n⚠️ ${failed} failed` : "")
  );

  console.log(`🗄️  Backup complete — ${passed}/${COLLECTIONS.length} collections sent to Telegram`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/** ms from now until the next occurrence of targetHour in IST (min 60s ahead) */
function msUntilHourIST(targetHour: number): number {
  const istNow    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const candidate = new Date(istNow);
  candidate.setHours(targetHour, 0, 0, 0);
  if (candidate.getTime() - istNow.getTime() < 60_000) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime() - istNow.getTime();
}

/** Chains setTimeout so the schedule stays accurate across day boundaries */
function scheduleNext(): void {
  const msToNext = Math.min(msUntilHourIST(2), msUntilHourIST(14));
  const display  = msToNext < 7_200_000
    ? `${Math.round(msToNext / 60_000)} min`
    : `${(msToNext / 3_600_000).toFixed(1)} hrs`;

  console.log(`🗄️  Next backup in ${display} (IST)`);

  setTimeout(async () => {
    await runBackup();
    scheduleNext();
  }, msToNext);
}

// ─── Restore (used by API + CLI) ──────────────────────────────────────────────

const MODEL_MAP: Record<string, any> = {
  Users: User, Leads: Lead, Teams: Team, Roles: Role,
  Courses: Course, AiMemories: AiMemory,
  PushSubscriptions: PushSubscription, TeamMessages: TeamMessage,
};

export function loadManifest(): BackupManifest {
  if (!fs.existsSync(MANIFEST_PATH)) return { backups: [] };
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as BackupManifest;
}

async function downloadFromTelegram(fileId: string): Promise<any[]> {
  const infoRes  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const infoJson = (await infoRes.json()) as { ok: boolean; result?: { file_path: string } };
  if (!infoJson.ok || !infoJson.result) throw new Error("Cannot resolve file from Telegram");
  const dlRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${infoJson.result.file_path}`);
  return JSON.parse(await dlRes.text()) as any[];
}

function restoreObjectIds(val: any): any {
  if (Array.isArray(val)) return val.map(restoreObjectIds);
  if (val && typeof val === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(val)) out[k] = restoreObjectIds(v);
    return out;
  }
  if (typeof val === "string" && val.length === 24 && /^[0-9a-fA-F]{24}$/.test(val)) {
    return new Types.ObjectId(val);
  }
  return val;
}

export interface RestoreResult {
  name:    string;
  count:   number;
  status:  "ok" | "failed";
  error?:  string;
}

export async function restoreFromManifestId(backupId: string): Promise<RestoreResult[]> {
  const manifest = loadManifest();
  const entry    = manifest.backups.find((b) => b.id === backupId);
  if (!entry) throw new Error(`Backup not found: ${backupId}`);

  const results: RestoreResult[] = [];

  for (const col of entry.collections) {
    try {
      const raw   = await downloadFromTelegram(col.fileId);
      const docs  = raw.map(restoreObjectIds);
      const model = MODEL_MAP[col.name];
      if (!model) throw new Error(`No model for collection: ${col.name}`);
      await model.deleteMany({});
      if (docs.length > 0) await model.collection.insertMany(docs, { ordered: false });
      results.push({ name: col.name, count: docs.length, status: "ok" });
    } catch (err) {
      results.push({ name: col.name, count: 0, status: "failed", error: (err as Error).message });
    }
  }

  return results;
}

export function startBackupScheduler(): void {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("⚠️  Backup scheduler disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");
    return;
  }
  console.log("🗄️  Backup scheduler started — runs at 2:00 AM and 2:00 PM IST");
  scheduleNext();
}
