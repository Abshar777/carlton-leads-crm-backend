import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { env } from "../config/env.js";
import { sendSuccess, sendError } from "../utils/response.js";

// GET /api/v1/push/vapid-public-key
export async function getVapidPublicKey(
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    sendSuccess(res, "VAPID public key", { publicKey: env.VAPID_PUBLIC_KEY });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/push/subscribe
export async function subscribePush(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { endpoint, keys } = req.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      sendError(res, "Invalid subscription object", 400);
      return;
    }

    const userId = req.user!.userId;

    // Upsert by endpoint
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { userId, endpoint, keys },
      { upsert: true, new: true }
    );

    sendSuccess(res, "Push subscription saved", null, 201);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/push/unsubscribe
export async function unsubscribePush(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { endpoint } = req.body as { endpoint?: string };
    if (!endpoint) {
      sendError(res, "Endpoint required", 400);
      return;
    }
    await PushSubscription.deleteOne({ endpoint, userId: req.user!.userId });
    sendSuccess(res, "Unsubscribed");
  } catch (err) {
    next(err);
  }
}
