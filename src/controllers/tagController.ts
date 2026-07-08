import type { Response, NextFunction } from "express";
import { z } from "zod";
import { TagService } from "../services/tagService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import type { AuthenticatedRequest } from "../types/index.js";

const tagService = new TagService();

const createTagSchema = z.object({
  name:  z.string().min(1, "Name is required").max(50, "Name too long"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a valid hex code (e.g. #ef4444)"),
});

const updateTagSchema = z
  .object({
    name:  z.string().min(1).max(50).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  })
  .refine((d) => d.name !== undefined || d.color !== undefined, {
    message: "At least one field (name or color) must be provided",
  });

export async function getAllTags(
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tags = await tagService.getAllTags();
    sendSuccess(res, "Tags fetched", tags);
  } catch (err) {
    next(err);
  }
}

export async function createTag(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { name, color } = createTagSchema.parse(req.body);
    const tag = await tagService.createTag(name, color, req.user!.userId);
    sendSuccess(res, "Tag created", tag, 201);
  } catch (err) {
    if (err instanceof z.ZodError) {
      sendError(res, err.issues[0].message, 400);
      return;
    }
    next(err);
  }
}

export async function updateTag(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const updates = updateTagSchema.parse(req.body);
    const tag = await tagService.updateTag(id, updates);
    sendSuccess(res, "Tag updated", tag);
  } catch (err) {
    if (err instanceof z.ZodError) {
      sendError(res, err.issues[0].message, 400);
      return;
    }
    next(err);
  }
}

export async function deleteTag(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    await tagService.deleteTag(id);
    sendSuccess(res, "Tag deleted");
  } catch (err) {
    next(err);
  }
}
