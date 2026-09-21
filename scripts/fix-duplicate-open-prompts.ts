/**
 * A user should only ever have one open call prompt. Two schedulers running
 * against the same database can create more, and because openSessionFor() only
 * ever looks at the newest one, every older duplicate stays open forever and
 * silently blocks that user from receiving any further prompts.
 *
 * Expires the older duplicates, keeping the newest open for the user to answer.
 * Dry run by default; pass --apply to write.
 */
import mongoose from "mongoose";
import { CallSession } from "../src/models/CallSession.js";
import { User } from "../src/models/User.js";

const apply = process.argv.includes("--apply");
await mongoose.connect(process.env.MONGODB_URI!);
void User;   // keep the model registered so populate("user") resolves

const open = await CallSession.find({ action: null })
  .populate("user", "name")
  .sort({ promptedAt: -1 })
  .lean();

const byUser = new Map<string, typeof open>();
for (const s of open) {
  const k = String((s.user as { _id?: unknown })?._id ?? s.user);
  byUser.set(k, [...(byUser.get(k) ?? []), s]);
}

const stale: typeof open = [];
for (const [, list] of byUser) {
  // list is newest-first; everything after the first is a blocking duplicate
  stale.push(...list.slice(1));
}

console.log(`users with an open prompt: ${byUser.size}`);
console.log(`blocking duplicates found: ${stale.length}\n`);
for (const s of stale) {
  console.log(`  ${(s.user as { name?: string })?.name ?? s.user}  prompted ${new Date(s.promptedAt).toISOString()}  id=${s._id}`);
}

if (!stale.length) {
  console.log("\nnothing to do");
} else if (!apply) {
  console.log("\nDRY RUN — re-run with --apply to expire these");
} else {
  const now = new Date();
  for (const s of stale) {
    await CallSession.updateOne(
      { _id: s._id },
      { $set: {
          action: "expired",
          respondedAt: now,
          holdSeconds: Math.round((now.getTime() - new Date(s.promptedAt).getTime()) / 1000),
      } },
    );
  }
  console.log(`\nexpired ${stale.length} duplicate prompt(s)`);
}

await mongoose.disconnect();
