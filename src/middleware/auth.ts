import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { sendError } from "../utils/response.js";
import { Role } from "../models/Role.js";
import { User } from "../models/User.js";

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      sendError(res, "Access token is required", 401);
      return;
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyAccessToken(token);

    // Verify user still exists and is active
    const user = await User.findById(decoded.userId).select("status");
    if (!user) {
      sendError(res, "User no longer exists", 401);
      return;
    }
    if (user.status === "inactive") {
      sendError(res, "Your account has been deactivated. Contact an administrator.", 403);
      return;
    }

    // Load role with permissions
    const role = await Role.findById(decoded.roleId);
    if (!role) {
      sendError(res, "Role not found", 401);
      return;
    }

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      roleId: decoded.roleId,
      role,
    };

    next();
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === "TokenExpiredError") {
        sendError(res, "Access token expired", 401);
        return;
      }
      if (error.name === "JsonWebTokenError") {
        sendError(res, "Invalid access token", 401);
        return;
      }
    }
    sendError(res, "Authentication failed", 401);
  }
};
