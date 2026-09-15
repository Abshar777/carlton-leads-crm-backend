import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { WorkScheduleService } from "../services/workScheduleService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const service = new WorkScheduleService();

/** Work schedules are Super Admin territory — the route guard is not specific enough. */
function requireSuperAdmin(req: AuthenticatedRequest, res: Response): boolean {
  const roleName = (req.user?.role as { roleName?: string } | undefined)?.roleName;
  if (roleName !== "Super Admin") {
    sendError(res, "Only a Super Admin can manage work schedules", 403);
    return false;
  }
  return true;
}

export const listWorkSchedules = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Readable by anyone signed in — the user page shows which schedule applies.
    const schedules = await service.list(req.query.includeInactive === "true");
    sendSuccess(res, "Work schedules retrieved", schedules);
  } catch (error) { next(error); }
};

export const createWorkSchedule = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const created = await service.create(req.body);
    sendSuccess(res, "Work schedule created", created, 201);
  } catch (error) { next(error); }
};

export const updateWorkSchedule = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const updated = await service.update(req.params.id, req.body);
    sendSuccess(res, "Work schedule updated", updated);
  } catch (error) { next(error); }
};

export const deleteWorkSchedule = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const result = await service.remove(req.params.id);
    sendSuccess(res, "Work schedule deleted", result);
  } catch (error) { next(error); }
};

/** PUT /users/:id/work-schedule — body { scheduleId: string | null } */
export const assignWorkSchedule = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const { scheduleId } = req.body as { scheduleId?: string | null };
    const user = await service.assign(req.params.id, scheduleId ?? null);
    sendSuccess(res, scheduleId ? "Work schedule assigned" : "Work schedule removed", user);
  } catch (error) { next(error); }
};
