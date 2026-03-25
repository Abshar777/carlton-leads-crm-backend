import type { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/response.js";

/**
 * Middleware that authenticates requests using a static API key.
 * Used for external integrations (Google Sheets App Script, webhooks, etc.)
 *
 * The caller must send:
 *   x-api-key: <SHEETS_API_KEY from .env>
 */
export const authenticateApiKey = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const apiKey = req.headers["x-api-key"];
  const expectedKey = process.env.SHEETS_API_KEY;

  if (!expectedKey) {
    sendError(res, "API key integration is not configured on this server", 503);
    return;
  }

  if (!apiKey || apiKey !== expectedKey) {
    sendError(res, "Invalid or missing API key", 401);
    return;
  }

  next();
};
