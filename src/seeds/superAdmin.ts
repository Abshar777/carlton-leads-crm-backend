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

// BDE role has limited permissions: can view/create/edit leads and view dashboard
const bdePermissions: PermissionsMap = {
  dashboard: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
  leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false },
  users: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
  roles: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
  reports: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
  settings: { view: false, create: false, edit: false, delete: false, approve: false, export: false },
};

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

    // Create or update BDE role
    let bdeRole = await Role.findOne({ roleName: "BDE" });
    if (!bdeRole) {
      bdeRole = await Role.create({
        roleName: "BDE",
        description: "Business Development Executive – manages and follows up on leads",
        permissions: bdePermissions,
        isSystemRole: false,
      });
      console.log("✅ BDE role created");
    } else {
      bdeRole.permissions = bdePermissions;
      await bdeRole.save();
      console.log("✅ BDE role updated");
    }

    // Create a sample BDE user
    const bdeSampleEmail = "bde@crm.com";
    const existingBde = await User.findOne({ email: bdeSampleEmail });
    if (!existingBde) {
      await User.create({
        name: "Sample BDE",
        email: bdeSampleEmail,
        password: "BdeUser@123",
        role: bdeRole._id,
        designation: "Business Development Executive",
        status: "active",
      });
      console.log(`✅ Sample BDE user created: ${bdeSampleEmail} (password: BdeUser@123)`);
    } else {
      console.log(`ℹ️  Sample BDE user already exists: ${bdeSampleEmail}`);
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
