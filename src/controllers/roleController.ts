import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { RoleService } from "../services/roleService.js";
import { createRoleSchema, updateRoleSchema } from "../validations/roleValidation.js";
import { sendSuccess, sendError } from "../utils/response.js";

const roleService = new RoleService();

export const createRole = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const role = await roleService.createRole(parsed.data);
    sendSuccess(res, "Role created successfully", role, 201);
  } catch (error) {
    next(error);
  }
};

export const getRoles = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { roles, pagination } = await roleService.getRoles(req.query as Record<string, string>);
    sendSuccess(res, "Roles retrieved successfully", roles, 200, pagination);
  } catch (error) {
    next(error);
  }
};

export const getRoleById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const role = await roleService.getRoleById(req.params.id);
    sendSuccess(res, "Role retrieved successfully", role);
  } catch (error) {
    next(error);
  }
};

export const updateRole = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const role = await roleService.updateRole(req.params.id, parsed.data);
    sendSuccess(res, "Role updated successfully", role);
  } catch (error) {
    next(error);
  }
};

export const deleteRole = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await roleService.deleteRole(req.params.id);
    sendSuccess(res, result.message);
  } catch (error) {
    next(error);
  }
};

export const getAllRolesSimple = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const roles = await roleService.getAllRolesSimple();
    sendSuccess(res, "Roles retrieved successfully", roles);
  } catch (error) {
    next(error);
  }
};
