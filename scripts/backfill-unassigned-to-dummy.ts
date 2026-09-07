#!/usr/bin/env bun
/**
 * Carlton CRM — Backfill teamless leads into the Dummy Team
 * ─────────────────────────────────────────────────────────────────────────────
 * Repairs leads that were created with no team while the workflow was enabled
 * (see mistakes.md Bug #8 — Google Sheets / WhatsApp paths bypassed the routing).
 *
 * Usage:
 *   bun scripts/backfill-unassigned-to-dummy.ts                 # DRY RUN (default)
 *   bun scripts/backfill-unassigned-to-dummy.ts --apply         # actually write
 *   bun scripts/backfill-unassigned-to-dummy.ts --since 2026-09-07
 *   bun scripts/backfill-unassigned-to-dummy.ts --apply --since 2026-09-07
 *
 * Safety:
 *   - Dry run unless --apply is passed. Prints exactly what it would change.
 *   - Only touches leads whose team is null/missing. Never reassigns an existing team.
 *   - Writes a `team_assigned` activity log to each lead, same shape as the app.
 *   - Idempotent: re-running finds nothing left to do.
 */

import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { Lead } from "../src/models/Lead.js";
import { Team } from "../src/models/Team.js";
import { Tag }  from "../src/models/Tag.js";
import { User } from "../src/models/User.js";

const args  = process.argv.slice(2);
const APPLY = args.includes("--apply");
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;

function bail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) bail("MONGODB_URI is not set. Run this where backend/.env has working credentials.");

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 }).catch((e) =>
  bail(`Could not connect to MongoDB: ${e.message}`),
);
console.log("✅ Connected to MongoDB\n");

// ── Locate the Dummy team ────────────────────────────────────────────────────
const dummyTag = await Tag.findOne({ name: /^Dummy$/i }).select("_id name").lean();
if (!dummyTag) bail('No tag named "Dummy" exists. Create it and assign it to the entry-point team.');

const dummyTeams = await Team.find({ tags: dummyTag._id, status: "active" }).select("_id name").lean();
if (dummyTeams.length === 0) bail('No ACTIVE team carries the "Dummy" tag.');
if (dummyTeams.length > 1) {
  bail(
    `${dummyTeams.length} active teams carry the "Dummy" tag (${dummyTeams.map((t) => t.name).join(", ")}). ` +
    `Remove the duplicate before running this backfill.`,
  );
}
const dummyTeam = dummyTeams[0];
console.log(`🎯 Target team: "${dummyTeam.name}" (${dummyTeam._id})\n`);

// ── Build the query ──────────────────────────────────────────────────────────
const query: Record<string, unknown> = { team: { $in: [null] } };
if (sinceArg) {
  const since = new Date(`${sinceArg}T00:00:00+05:30`); // IST
  if (isNaN(since.getTime())) bail(`--since "${sinceArg}" is not a valid date (expected YYYY-MM-DD).`);
  query.createdAt = { $gte: since };
  console.log(`📅 Scope: leads created on/after ${since.toISOString()} (IST midnight)\n`);
} else {
  console.log("📅 Scope: ALL teamless leads (no --since given)\n");
}

const leads = await Lead.find(query).select("_id name phone source createdAt").sort({ createdAt: 1 }).lean();

if (leads.length === 0) {
  console.log("✨ Nothing to do — no teamless leads matched.\n");
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`Found ${leads.length} teamless lead(s):\n`);
for (const l of leads.slice(0, 25)) {
  const when = new Date(l.createdAt as Date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`   • ${String(l.name).padEnd(24)} ${String(l.phone).padEnd(16)} ${String(l.source ?? "—").padEnd(10)} ${when}`);
}
if (leads.length > 25) console.log(`   … and ${leads.length - 25} more`);

// ── Apply ────────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`\n🔍 DRY RUN — nothing was written.`);
  console.log(`   Re-run with --apply to move these ${leads.length} lead(s) into "${dummyTeam.name}".\n`);
  await mongoose.disconnect();
  process.exit(0);
}

const superAdmin = await User.findOne({ email: process.env.SUPER_ADMIN_EMAIL }).select("_id").lean();
if (!superAdmin) bail("Super Admin not found — check SUPER_ADMIN_EMAIL in .env (needed for the audit log).");

const ids = leads.map((l) => l._id);
const result = await Lead.updateMany(
  { _id: { $in: ids }, team: { $in: [null] } }, // re-check team, in case it changed since the read
  {
    $set: { team: new Types.ObjectId(String(dummyTeam._id)) },
    $push: {
      activityLogs: {
        action: "team_assigned",
        description: `Lead backfilled into team "${dummyTeam.name}" (workflow routing repair)`,
        performedBy: superAdmin._id,
        createdAt: new Date(),
      },
    },
  },
);

console.log(`\n✅ Updated ${result.modifiedCount} of ${leads.length} lead(s) → "${dummyTeam.name}"`);
if (result.modifiedCount !== leads.length) {
  console.log(`   ⚠️  ${leads.length - result.modifiedCount} skipped — their team changed between read and write.`);
}
console.log();

await mongoose.disconnect();
