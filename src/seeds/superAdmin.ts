import "dotenv/config";
import mongoose from "mongoose";
import { Role } from "../models/Role.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import type { PermissionsMap } from "../types/index.js";
import { CRM_MODULES } from "../types/index.js";

const superAdminPermissions: PermissionsMap = Object.fromEntries(
  CRM_MODULES.map((mod) => [
    mod,
    { view: true, create: true, edit: true, delete: true, approve: true, export: true },
  ])
) as PermissionsMap;

async function seed() {
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // Create or update Super Admin role
    let superAdminRole = await Role.findOne({ roleName: "Super Admin" });
    if (!superAdminRole) {
      superAdminRole = await Role.create({
        roleName: "Super Admin",
        description: "Full system access with all permissions",
        permissions: superAdminPermissions,
        isSystemRole: true,
      });
      console.log("✅ Super Admin role created");
    } else {
      superAdminRole.permissions = superAdminPermissions;
      superAdminRole.isSystemRole = true;
      await superAdminRole.save();
      console.log("✅ Super Admin role updated");
    }

    // Create Super Admin user
    const existingUser = await User.findOne({ email: env.SUPER_ADMIN_EMAIL.toLowerCase() });
    if (!existingUser) {
      await User.create({
        name: env.SUPER_ADMIN_NAME,
        email: env.SUPER_ADMIN_EMAIL.toLowerCase(),
        password: env.SUPER_ADMIN_PASSWORD,
        role: superAdminRole._id,
        designation: "Super Administrator",
        status: "active",
      });
      console.log(`✅ Super Admin user created: ${env.SUPER_ADMIN_EMAIL}`);
    } else {
      console.log(`ℹ️  Super Admin user already exists: ${env.SUPER_ADMIN_EMAIL}`);
    }

    console.log("✅ Seeding complete!");
  } catch (error) {
    console.error("❌ Seed error:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

seed();
