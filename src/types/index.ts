import type { Request } from "express";
import type { Document, Types } from "mongoose";

// ─── Permission Actions ────────────────────────────────────────────────────────
export type PermissionAction = "view" | "create" | "edit" | "delete" | "approve" | "export";

export interface ModulePermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  export: boolean;
}

// All available modules in the CRM
export const CRM_MODULES = [
  "dashboard",
  "users",
  "roles",
  "leads",
  "reports",
  "settings",
] as const;

export type CrmModule = (typeof CRM_MODULES)[number];

export type PermissionsMap = {
  [K in CrmModule]?: ModulePermissions;
};

// ─── Role ─────────────────────────────────────────────────────────────────────
export interface IRole extends Document {
  _id: Types.ObjectId;
  roleName: string;
  description?: string;
  permissions: PermissionsMap;
  isSystemRole: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── User ─────────────────────────────────────────────────────────────────────
export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  password: string;
  role: Types.ObjectId | IRole;
  designation?: string;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface JwtPayload {
  userId: string;
  email: string;
  roleId: string;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    roleId: string;
    role?: IRole;
  };
}

// ─── API Response ─────────────────────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: unknown;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  status?: string;
  role?: string;
  isSystemRole?: string;
}

// ─── Team ─────────────────────────────────────────────────────────────────────
export interface ITeam extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  leaders: Types.Array<Types.ObjectId | IUser>;
  members: Types.Array<Types.ObjectId | IUser>;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamFilters {
  search?: string;
  status?: string;
  page?: string;
  limit?: string;
}

// ─── Course ───────────────────────────────────────────────────────────────────
export interface ICourse extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  amount: number;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

// ─── Lead ──────────────────────────────────────────────────────────────────────
export type LeadStatus = "new" | "assigned" | "followup" | "closed" | "rejected" | "cnc" | "booking" | "interested";

export type ActivityAction =
  | "lead_created"
  | "lead_updated"
  | "status_changed"
  | "lead_assigned"
  | "team_assigned"
  | "note_added"
  | "note_updated"
  | "note_deleted";

export interface ILeadNote {
  _id: Types.ObjectId;
  content: string;
  author: Types.ObjectId | IUser;
  createdAt: Date;
  updatedAt: Date;
}

export interface IActivityLog {
  _id: Types.ObjectId;
  action: ActivityAction;
  description: string;
  performedBy: Types.ObjectId | IUser;
  changes?: Record<string, { from: unknown; to: unknown }>;
  createdAt: Date;
}

export interface ILead extends Document {
  _id: Types.ObjectId;
  name: string;
  email?: string;
  phone: string;
  source?: string;
  status: LeadStatus;
  course?: Types.ObjectId | ICourse;
  assignedTo?: Types.ObjectId | IUser;
  team?: Types.ObjectId | ITeam;
  reporter: Types.ObjectId | IUser;
  notes: Types.DocumentArray<ILeadNote & Document>;
  activityLogs: Types.DocumentArray<IActivityLog & Document>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadFilters {
  status?: LeadStatus;
  assignedTo?: string;
  team?: string;
  reporter?: string;
  course?: string;
  search?: string;
  /** ISO date string – filter leads created on or after this date (inclusive) */
  dateFrom?: string;
  /** ISO date string – filter leads created on or before this date (inclusive, end of day) */
  dateTo?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface LeadStats {
  total: number;
  new: number;
  assigned: number;
  followup: number;
  closed: number;
  rejected: number;
}

export interface ParsedLead {
  name: string;
  email?: string;
  phone: string;
  source?: string;
  notes?: string;
}

export interface ExcelParseResult {
  valid: ParsedLead[];
  invalid: { row: number; data: Record<string, unknown>; errors: string[] }[];
}

export interface AutoAssignResult {
  assigned: number;
  results: { leadId: string; assignedTo: string }[];
}
