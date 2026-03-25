import { Course } from "../models/Course.js";
import { buildPagination } from "../utils/response.js";
import type { ICourse } from "../types/index.js";

export interface CourseFilters {
  search?: string;
  status?: string;
  page?: string;
  limit?: string;
}

export class CourseService {
  // ── Create ──────────────────────────────────────────────────────────────────
  async createCourse(data: { name: string; description?: string; amount: number; status?: string }) {
    const course = await Course.create(data);
    return course;
  }

  // ── List ─────────────────────────────────────────────────────────────────────
  async getCourses(filters: CourseFilters) {
    const page = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (filters.status) query.status = filters.status;

    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { description: regex }];
    }

    const [courses, total] = await Promise.all([
      Course.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Course.countDocuments(query),
    ]);

    return { courses, pagination: buildPagination(total, page, limit) };
  }

  // ── Get All (for dropdowns) ──────────────────────────────────────────────────
  async getAllCourses() {
    return Course.find({ status: "active" }).sort({ name: 1 }).lean();
  }

  // ── Get by ID ────────────────────────────────────────────────────────────────
  async getCourseById(id: string) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    return course;
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  async updateCourse(id: string, data: Partial<{ name: string; description: string; amount: number; status: string }>) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });

    Object.assign(course, data);
    await course.save();
    return course;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async deleteCourse(id: string) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await Course.findByIdAndDelete(id);
    return { message: "Course deleted successfully" };
  }
}
