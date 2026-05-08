import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { loadManifest, runBackup, restoreFromManifestId } from "../services/backupService.js";

export const getManifest = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const manifest = loadManifest();
    sendSuccess(res, "Backup manifest retrieved", manifest);
  } catch (err) {
    next(err);
  }
};

export const triggerBackup = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Run async, respond immediately so the request doesn't time out
    runBackup().catch((err) => console.error("Background backup error:", err));
    sendSuccess(res, "Backup started", { started: true });
  } catch (err) {
    next(err);
  }
};

export const restoreBackup = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { backupId } = req.body as { backupId?: string };
    if (!backupId) {
      sendError(res, "backupId is required", 400);
      return;
    }
    const results = await restoreFromManifestId(backupId);
    sendSuccess(res, "Restore complete", results);
  } catch (err) {
    next(err);
  }
};
