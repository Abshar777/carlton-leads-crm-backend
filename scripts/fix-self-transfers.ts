#!/usr/bin/env bun
/**
 * Carlton CRM — Clear previousTeam where it equals the current team
 * ─────────────────────────────────────────────────────────────────────────────
 * A lead already in the Closing team used to be "transferred" to itself by the
 * workflow, stamping previousTeam with the same team. Those leads then appeared
 * under BOTH Transferred In and Transferred Out.
 *
 * The cause is fixed in leadService; this clears the rows it already produced.
 *
 * Usage:
 *   bun scripts/fix-self-transfers.ts           # DRY RUN (default)
 *   bun scripts/fix-self-transfers.ts --apply
 *
 * Safety:
 *   - Dry run unless --apply
 *   - Only touches leads where previousTeam === team; never a real transfer
 *   - transferredAt is left alone: the lead did change status, and the date is
 *     still meaningful. Only the bogus previousTeam link is removed.
 *   - Idempotent
 */

import "dotenv/config";
import mongoose from "mongoose";
import { Lead } from "../src/models/Lead.js";
import { Team } from "../src/models/Team.js";

const APPLY = process.argv.includes("--apply");

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("\n❌ MONGODB_URI is not set.\n"); process.exit(1); }
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 }).catch((e) => {
  console.error(`\n❌ Could not connect: ${e.message}\n`); process.exit(1);
});
console.log("✅ Connected to MongoDB\n");

const rows = await Lead.aggregate([
  { $match: { previousTeam: { $ne: null } } },
  { $match: { $expr: { $eq: ["$team", "$previousTeam"] } } },
  { $project: { team: 1, name: 1 } },
]);

if (rows.length === 0) {
  console.log("✨ Nothing to do — no lead points at itself.\n");
  await mongoose.disconnect();
  process.exit(0);
}

const byTeam = new Map<string, number>();
for (const r of rows) {
  const t = await Team.findById(r.team).select("name").lean();
  const n = (t as { name?: string } | null)?.name ?? "unknown";
  byTeam.set(n, (byTeam.get(n) ?? 0) + 1);
}

console.log(`Found ${rows.length} lead(s) whose previousTeam is their own team:\n`);
for (const [name, n] of [...byTeam.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(4)}  ${name}`);
}

if (!APPLY) {
  console.log(`\n🔍 DRY RUN — nothing was written.`);
  console.log(`   Re-run with --apply to clear previousTeam on these ${rows.length} lead(s).\n`);
  await mongoose.disconnect();
  process.exit(0);
}

const res = await Lead.updateMany(
  { _id: { $in: rows.map((r) => r._id) }, $expr: { $eq: ["$team", "$previousTeam"] } },
  { $set: { previousTeam: null } },
);

console.log(`\n✅ Cleared previousTeam on ${res.modifiedCount} of ${rows.length} lead(s)\n`);
await mongoose.disconnect();
