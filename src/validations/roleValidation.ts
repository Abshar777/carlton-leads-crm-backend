import { z } from "zod";
import { CRM_MODULES } from "../types/index.js";

const modulePermissionsSchema = z.object({
  view: z.boolean().default(false),
  create: z.boolean().default(false),
  edit: z.boolean().default(false),
  delete: z.boolean().default(false),
  approve: z.boolean().default(false),
  export: z.boolean().default(false),
});

// Build permissions schema from CRM_MODULES
const permissionsSchema = z
  .object(
    Object.fromEntries(CRM_MODULES.map((mod) => [mod, modulePermissionsSchema.optional()]))
  )
  .optional();

export const createRoleSchema = z.object({
  roleName: z.string().min(1, "Role name is required").max(50),
  description: z.string().max(200).optional(),
  permissions: permissionsSchema,
});

export const updateRoleSchema = z.object({
  roleName: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional().nullable(),
  permissions: permissionsSchema,
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
