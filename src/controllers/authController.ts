import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { AuthService } from "../services/authService.js";
import { loginSchema, refreshTokenSchema, changePasswordSchema } from "../validations/authValidation.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { LoginEvent } from "../models/LoginEvent.js";
import { getOnlineUserIds } from "../socket.js";

const authService = new AuthService();

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const result = await authService.login(parsed.data);

    // Log login event (fire and forget)
    const userId = (result as unknown as { user?: { _id?: string } }).user?._id;
    if (userId) {
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";
      LoginEvent.create({ user: userId, type: "login", ipAddress: ip, userAgent: req.headers["user-agent"] ?? "" }).catch(() => {});
    }

    sendSuccess(res, "Login successful", result, 200);
  } catch (error) {
    next(error);
  }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = refreshTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const result = await authService.refreshToken(parsed.data.refreshToken);
    sendSuccess(res, "Token refreshed successfully", result, 200);
  } catch (error) {
    next(error);
  }
};

export const getProfile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await authService.getProfile(req.user!.userId);
    sendSuccess(res, "Profile retrieved successfully", user);
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const result = await authService.changePassword(req.user!.userId, parsed.data);
    sendSuccess(res, result.message);
  } catch (error) {
    next(error);
  }
};

export const getLoginHistory = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId, dateFrom, dateTo, page = "1", limit = "50" } = req.query as Record<string, string>;
    const query: Record<string, unknown> = {};
    if (userId) query.user = userId;
    if (dateFrom || dateTo) {
      const range: Record<string, Date> = {};
      if (dateFrom) range.$gte = new Date(dateFrom);
      if (dateTo)   range.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
      query.createdAt = range;
    }
    const p = parseInt(page);
    const l = parseInt(limit);
    const [events, total] = await Promise.all([
      LoginEvent.find(query)
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      LoginEvent.countDocuments(query),
    ]);
    sendSuccess(res, "Login history fetched", { events, total, page: p, limit: l, pages: Math.ceil(total / l) });
  } catch (error) {
    next(error);
  }
};

export const getOnlineUsers = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ids = getOnlineUserIds();
    sendSuccess(res, "Online users", { onlineUserIds: ids });
  } catch (error) {
    next(error);
  }
};
