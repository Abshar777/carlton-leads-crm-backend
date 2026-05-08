import "dotenv/config";
import { connectDB } from "../src/config/database.js";
import { runBackup } from "../src/services/backupService.js";

await connectDB();
await runBackup();
process.exit(0);
