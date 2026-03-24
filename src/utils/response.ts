import type { Response } from "express";
import type { ApiResponse, PaginationMeta } from "../types/index.js";

export const sendSuccess = <T>(
  res: Response,
  message: string,
  data?: T,
  statusCode = 200,
  pagination?: PaginationMeta
): void => {
  const response: ApiResponse<T> = { success: true, message, data, pagination };
  res.status(statusCode).json(response);
};

export const sendError = (
  res: Response,
  message: string,
  statusCode = 500,
  errors?: unknown
): void => {
  const response: ApiResponse = { success: false, message, errors };
  res.status(statusCode).json(response);
};

export const buildPagination = (
  total: number,
  page: number,
  limit: number
): PaginationMeta => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
  hasNextPage: page < Math.ceil(total / limit),
  hasPrevPage: page > 1,
});
