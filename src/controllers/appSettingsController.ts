import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { z } from "zod";
import { getOrCreateSettings } from "../models/AppSettings.js";
import { sendSuccess, sendError } from "../utils/response.js";

/** GET /api/v1/settings/app */
export const getAppSettings = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const settings = await getOrCreateSettings();
    sendSuccess(res, "Settings fetched", {
      workflowEnabled: settings.workflowEnabled,
    });
  } catch (err) {
    next(err);
  }
};

const updateSchema = z.object({
  workflowEnabled: z.boolean(),
});

/** PATCH /api/v1/settings/app */
export const updateAppSettings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const settings = await getOrCreateSettings();
    settings.workflowEnabled = parsed.data.workflowEnabled;
    await settings.save();
    sendSuccess(res, "Settings updated", { workflowEnabled: settings.workflowEnabled });
  } catch (err) {
    next(err);
  }
};
