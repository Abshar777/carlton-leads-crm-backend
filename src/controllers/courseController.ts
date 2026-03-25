import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { CourseService } from "../services/courseService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const courseService = new CourseService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createCourseSchema = z.object({
  name: z.string().min(1, "Course name is required").max(150),
  description: z.string().max(1000).optional(),
  amount: z.number().min(0, "Amount cannot be negative"),
  status: z.enum(["active", "inactive"]).optional(),
});

const updateCourseSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  description: z.string().max(1000).optional().nullable(),
  amount: z.number().min(0).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

// ─── Controllers ─────────────────────────────────────────────────────────────

export const createCourse = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = createCourseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const course = await courseService.createCourse(parsed.data);
    sendSuccess(res, "Course created successfully", course, 201);
  } catch (err) {
    next(err);
  }
};

export const getCourses = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { search, status, page, limit } = req.query as Record<string, string>;
    const result = await courseService.getCourses({ search, status, page, limit });
    sendSuccess(res, "Courses fetched successfully", result.courses, 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

export const getAllCourses = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const courses = await courseService.getAllCourses();
    sendSuccess(res, "Courses fetched successfully", courses);
  } catch (err) {
    next(err);
  }
};

export const getCourseById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const course = await courseService.getCourseById(req.params.id);
    sendSuccess(res, "Course fetched successfully", course);
  } catch (err) {
    next(err);
  }
};

export const updateCourse = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateCourseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const course = await courseService.updateCourse(req.params.id, parsed.data as Record<string, unknown>);
    sendSuccess(res, "Course updated successfully", course);
  } catch (err) {
    next(err);
  }
};

export const deleteCourse = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await courseService.deleteCourse(req.params.id);
    sendSuccess(res, result.message, null);
  } catch (err) {
    next(err);
  }
};
