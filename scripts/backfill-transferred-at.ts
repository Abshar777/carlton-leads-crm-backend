#!/usr/bin/env bun
/**
 * Carlton CRM — Backfill transferredAt from team_changed activity logs
 * ─────────────────────────────────────────────────────────────────────────────
 * transferredAt was added after the fact, so leads transferred before it existed
 * have no date. Their team_changed activity log does carry one — this copies the
 * MOST RECENT such log onto the lead.
 *
 * Usage:
 *   bun scripts/backfill-transferred-at.ts            # DRY RUN (default)
 *   bun scripts/backfill-transferred-at.ts --apply
 *
 * Safety:
 *   - Dry run unless --apply
 *   - Only fills leads where transferredAt is null/missing; never overwrites a
 *     value already set by a live transfer
 *   - Idempotent: a second run finds nothing to do
 */

import "dotenv/config";
import mongoose from "mongoose";
import { Lead } from "../src/models/Lead.js";

const APPLY = process.argv.includes("--apply");

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("\n❌ MONGODB_URI is not set.\n"); process.exit(1); }
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 }).catch((e) => {
  console.error(`\n❌ Could not connect: ${e.message}\n`); process.exit(1);
});
console.log("✅ Connected to MongoDB\n");

const candidates = await Lead.aggregate([
  { $match: {
      transferredAt: { $in: [null] },
      "activityLogs.action": "team_changed",
  } },
  { $project: {
      when: {
        $max: {
          $map: {
            input: { $filter: {
              input: "$activityLogs",
              as: "l",
              cond: { $eq: ["$$l.action", "team_changed"] },
            } },
            as: "l",
            in: "$$l.createdAt",
          },
        },
      },
  } },
  { $match: { when: { $ne: null } } },
]);

if (candidates.length === 0) {
  console.log("✨ Nothing to do — every transferred lead already has a date.\n");
  await mongoose.disconnect();
  process.exit(0);
}

const fmt = (d: Date) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const byDay = new Map<string, number>();
for (const c of candidates) {
  const k = fmt(c.when).split(",")[0];
  byDay.set(k, (byDay.get(k) ?? 0) + 1);
}
console.log(`Found ${candidates.length} lead(s) with a transfer date to restore:\n`);
for (const [day, n] of [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`   ${String(n).padStart(5)}  ${day}`);
}
if (byDay.size > 12) console.log(`   … and ${byDay.size - 12} more day(s)`);

if (!APPLY) {
  console.log(`\n🔍 DRY RUN — nothing was written.`);
  console.log(`   Re-run with --apply to stamp these ${candidates.length} lead(s).\n`);
  await mongoose.disconnect();
  process.exit(0);
}

const ops = candidates.map((c) => ({
  updateOne: {
    filter: { _id: c._id, transferredAt: { $in: [null] } }, // re-check
    update: { $set: { transferredAt: c.when } },
  },
}));

let written = 0;
for (let i = 0; i < ops.length; i += 500) {
  const res = await Lead.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  written += res.modifiedCount ?? 0;
}

console.log(`\n✅ Stamped ${written} of ${candidates.length} lead(s)`);
if (written !== candidates.length) {
  console.log(`   ⚠️  ${candidates.length - written} skipped — changed between read and write.`);
}
console.log();
await mongoose.disconnect();
