import type { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { sendError } from "../utils/response.js";
import { env } from "../config/env.js";

export const errorHandler = (
  err: Error & { statusCode?: number; code?: number; keyValue?: Record<string, unknown> },
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  console.error("Error:", err);

  // Mongoose validation error
  if (err instanceof mongoose.Error.ValidationError) {
    const messages = Object.values(err.errors).map((e) => e.message);
    sendError(res, "Validation failed", 400, messages);
    return;
  }

  // Mongoose duplicate key error
  if (err.code === 11000 && err.keyValue) {
    const field = Object.keys(err.keyValue)[0];
    sendError(res, `${field} already exists`, 409);
    return;
  }

  // Mongoose cast error (invalid ObjectId)
  if (err instanceof mongoose.Error.CastError) {
    sendError(res, "Invalid ID format", 400);
    return;
  }

  const statusCode = err.statusCode ?? 500;
  const message =
    env.NODE_ENV === "production" && statusCode === 500
      ? "Internal server error"
      : err.message;

  sendError(res, message, statusCode);
};

export const notFound = (_req: Request, res: Response): void => {
  sendError(res, "Route not found", 404);
};
