#!/usr/bin/env bun
/**
 * Carlton CRM — Backfill booking leads into the Closing Team
 * ─────────────────────────────────────────────────────────────────────────────
 * Moves leads with status "booking" that are not already in the Closing Team.
 * These missed the automatic booking -> Closing transfer, either because the
 * Closing team was inactive (see mistakes.md) or because they predate the
 * workflow being enabled.
 *
 * Usage:
 *   bun scripts/backfill-booking-to-closing.ts                  # DRY RUN (default)
 *   bun scripts/backfill-booking-to-closing.ts --apply          # actually write
 *   bun scripts/backfill-booking-to-closing.ts --since 2026-09-05
 *   bun scripts/backfill-booking-to-closing.ts --apply --since 2026-09-05
 *
 * Safety:
 *   - Dry run unless --apply. Prints a per-team breakdown of what would move.
 *   - Only touches status "booking" leads not already in the Closing Team.
 *   - Records previousTeam and writes a team_changed activity log, matching
 *     what the live workflow transfer does.
 *   - Does NOT change assignedTo or status — same as the workflow transfer.
 *   - Re-checks the team at write time so concurrent changes are skipped.
 *   - Idempotent: a second run finds nothing to do.
 */

import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { Lead } from "../src/models/Lead.js";
import { Team } from "../src/models/Team.js";
import { Tag }  from "../src/models/Tag.js";
import { User } from "../src/models/User.js";

const args     = process.argv.slice(2);
const APPLY    = args.includes("--apply");
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;

function bail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) bail("MONGODB_URI is not set.");
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 }).catch((e) =>
  bail(`Could not connect to MongoDB: ${e.message}`),
);
console.log("✅ Connected to MongoDB\n");

// ── Locate the Closing team ──────────────────────────────────────────────────
const tag = await Tag.findOne({ name: /^Closing$/i }).select("_id").lean();
if (!tag) bail('No tag named "Closing" exists.');

const teams = await Team.find({ tags: tag._id, status: "active" }).select("_id name").lean();
if (teams.length === 0) {
  const inactive = await Team.find({ tags: tag._id }).select("name status").lean();
  bail(
    inactive.length
      ? `The "Closing" tag is only on inactive team(s): ${inactive.map((t) => `${t.name} (${t.status})`).join(", ")}. Reactivate one first.`
      : 'The "Closing" tag is not assigned to any team.',
  );
}
if (teams.length > 1) {
  bail(`${teams.length} active teams carry the "Closing" tag (${teams.map((t) => t.name).join(", ")}). Remove the duplicate first.`);
}
const closing = teams[0];
console.log(`🎯 Target team: "${closing.name}" (${closing._id})\n`);

// ── Build the query ──────────────────────────────────────────────────────────
const query: Record<string, unknown> = { status: "booking", team: { $ne: closing._id } };
if (sinceArg) {
  const since = new Date(`${sinceArg}T00:00:00+05:30`); // IST
  if (isNaN(since.getTime())) bail(`--since "${sinceArg}" is not a valid date (expected YYYY-MM-DD).`);
  query.updatedAt = { $gte: since };
  console.log(`📅 Scope: booking leads updated on/after ${since.toISOString()}\n`);
} else {
  console.log("📅 Scope: ALL booking leads not already in the Closing Team\n");
}

const leads = await Lead.find(query).select("_id name team").populate("team", "name").lean();
if (leads.length === 0) {
  console.log("✨ Nothing to do — every booking lead is already in the Closing Team.\n");
  await mongoose.disconnect();
  process.exit(0);
}

// Breakdown by current team
const byTeam = new Map<string, number>();
for (const l of leads) {
  const n = (l.team as unknown as { name?: string })?.name ?? "NO TEAM";
  byTeam.set(n, (byTeam.get(n) ?? 0) + 1);
}
console.log(`Found ${leads.length} booking lead(s) to move into "${closing.name}":\n`);
for (const [name, n] of [...byTeam.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(5)}  from  ${name}`);
}

if (!APPLY) {
  console.log(`\n🔍 DRY RUN — nothing was written.`);
  console.log(`   Re-run with --apply to move these ${leads.length} lead(s).\n`);
  await mongoose.disconnect();
  process.exit(0);
}

const admin = await User.findOne({ email: process.env.SUPER_ADMIN_EMAIL }).select("_id").lean();
if (!admin) bail("Super Admin not found — check SUPER_ADMIN_EMAIL in .env (needed for the audit log).");

// ── Apply, one bulk op per source team so previousTeam is recorded correctly ──
const bySource = new Map<string, Types.ObjectId[]>();
for (const l of leads) {
  const key = l.team ? String((l.team as unknown as { _id: unknown })._id) : "none";
  if (!bySource.has(key)) bySource.set(key, []);
  bySource.get(key)!.push(l._id as Types.ObjectId);
}

let moved = 0;
for (const [sourceId, ids] of bySource.entries()) {
  const prev = sourceId === "none" ? null : new Types.ObjectId(sourceId);
  const res = await Lead.updateMany(
    { _id: { $in: ids }, status: "booking", team: { $ne: closing._id } }, // re-check
    {
      $set: { team: closing._id, previousTeam: prev },
      $push: {
        activityLogs: {
          action: "team_changed",
          description: "Lead backfilled into Closing Team (missed workflow transfer)",
          performedBy: admin._id,
          createdAt: new Date(),
        },
      },
    },
  );
  moved += res.modifiedCount;
}

console.log(`\n✅ Moved ${moved} of ${leads.length} lead(s) → "${closing.name}"`);
if (moved !== leads.length) {
  console.log(`   ⚠️  ${leads.length - moved} skipped — changed between read and write.`);
}
console.log();
await mongoose.disconnect();
