import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { CallSession } from "../models/CallSession.js";
import { WorkSchedule } from "../models/WorkSchedule.js";
import { User } from "../models/User.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { shiftStateFor, nextLeadFor, openSessionFor, onBreak, adminOverview, notifyAdminsOfCallActivity } from "../services/callAutomationService.js";

/** GET /call-automation/my-session — what, if anything, is waiting on me. */
export const getMySession = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const user = await User.findById(userId).populate("workSchedule").select("workSchedule").lean();
    const schedule = user?.workSchedule as unknown as Parameters<typeof shiftStateFor>[0] | null;

    // No schedule means no prompts at all, by design
    if (!schedule) return sendSuccess(res, "No schedule", { onShift: false, session: null, breakEndsAt: null });

    const { onShift, mode } = shiftStateFor(schedule);
    const breaking = await CallSession.findOne({ user: userId, action: "break", breakEndsAt: { $gt: new Date() } })
      .select("breakEndsAt").lean();

    const open = await openSessionFor(userId);
    const populated = open
      ? await CallSession.findById(open._id).populate("lead", "name phone status").lean()
      : null;

    return sendSuccess(res, "Session state", {
      onShift, mode,
      breakEndsAt: breaking?.breakEndsAt ?? null,
      session: populated,
    });
  } catch (error) { next(error); }
};

/** POST /call-automation/sessions/:id/respond — body { action, rejectReason? } */
export const respondToSession = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { action, rejectReason } = req.body as { action?: string; rejectReason?: string };
    const allowed = ["called", "updated", "rejected", "break"];
    if (!action || !allowed.includes(action)) {
      return sendError(res, `action must be one of: ${allowed.join(", ")}`, 400);
    }
    // Mandatory, as specified — a rejection with no reason tells an admin nothing
    if (action === "rejected" && !rejectReason?.trim()) {
      return sendError(res, "A reason is required when rejecting a call", 400);
    }

    const session = await CallSession.findOne({ _id: req.params.id, user: req.user!.userId });
    if (!session) return sendError(res, "Call session not found", 404);
    if (session.action) return sendError(res, "This prompt has already been answered", 409);

    const now = new Date();
    session.action = action as never;
    session.respondedAt = now;
    session.holdSeconds = Math.round((now.getTime() - session.promptedAt.getTime()) / 1000);
    if (action === "rejected") session.rejectReason = rejectReason!.trim();

    if (action === "break") {
      const user = await User.findById(req.user!.userId).populate("workSchedule").select("workSchedule").lean();
      const mins = (user?.workSchedule as unknown as { breakMinutes?: number } | null)?.breakMinutes ?? 15;
      session.breakMinutes = mins;
      session.breakEndsAt = new Date(now.getTime() + mins * 60_000);
    }

    await session.save();
    void notifyAdminsOfCallActivity({ sessionId: session._id.toString(), action });
    return sendSuccess(res, "Recorded", session);
  } catch (error) { next(error); }
};

/** POST /call-automation/break/end — come back early from a break. */
export const endBreak = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    await CallSession.updateMany(
      { user: req.user!.userId, action: "break", breakEndsAt: { $gt: now } },
      { $set: { breakEndsAt: now } },
    );
    void notifyAdminsOfCallActivity({ action: "break-ended", userId: req.user!.userId });
    return sendSuccess(res, "Break ended", { endedAt: now });
  } catch (error) { next(error); }
};

/** GET /call-automation/next-lead — used by "Call Next" to know who to dial. */
export const getNextLead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (await onBreak(req.user!.userId)) return sendSuccess(res, "On break", null);
    const lead = await nextLeadFor(req.user!.userId);
    return sendSuccess(res, lead ? "Next lead" : "Queue is empty", lead);
  } catch (error) { next(error); }
};

/** GET /call-automation/overview — Super Admin only. Rejections, long holds, breaks. */
export const getOverview = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const roleName = (req.user?.role as { roleName?: string } | undefined)?.roleName;
    if (roleName !== "Super Admin") {
      return sendError(res, "Only a Super Admin can view call automation", 403);
    }
    const { dateFrom, dateTo, userId } = req.query as Record<string, string | undefined>;
    const data = await adminOverview({ dateFrom, dateTo, userId });
    return sendSuccess(res, "Call automation overview", data);
  } catch (error) { next(error); }
};
