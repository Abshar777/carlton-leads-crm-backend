import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { Types } from "mongoose";
import { CallSession, CALL_RESULTS, type CallResult } from "../models/CallSession.js";
import { WorkSchedule } from "../models/WorkSchedule.js";
import { User } from "../models/User.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { shiftStateFor, nextLeadFor, openSessionFor, onBreak, pendingOutcomeFor, awaitingBreakReturnFor, adminOverview, notifyAdminsOfCallActivity } from "../services/callAutomationService.js";

/** GET /call-automation/my-session — what, if anything, is waiting on me. */
export const getMySession = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const user = await User.findById(userId).populate("workSchedule").select("workSchedule").lean();
    const schedule = user?.workSchedule as unknown as Parameters<typeof shiftStateFor>[0] | null;

    // These four are owed regardless of any schedule: losing a schedule must not
    // wipe a break someone is on, a write-up they owe, or a question already
    // asked of them. Only the shift state and the next prompt depend on it.
    const breaking = await CallSession.findOne({ user: userId, action: "break", breakEndsAt: { $gt: new Date() } })
      .select("breakEndsAt").lean();

    const owing = await pendingOutcomeFor(userId);
    const pendingOutcome = owing
      ? await CallSession.findById(owing._id).populate("lead", "name phone status").lean()
      : null;

    // Break is over but they have not said they are back.
    const backYet = await awaitingBreakReturnFor(userId);
    const breakReturn = backYet
      ? {
          _id: String(backYet._id),
          breakEndsAt: backYet.breakEndsAt,
          breakReturnPromptedAt: backYet.breakReturnPromptedAt,
          breakExtensions: backYet.breakExtensions ?? 0,
        }
      : null;

    // No schedule means no new prompts, by design
    if (!schedule) {
      return sendSuccess(res, "No schedule", {
        onShift: false, session: null,
        breakEndsAt: breaking?.breakEndsAt ?? null,
        pendingOutcome,
        breakReturn,
      });
    }

    const { onShift, mode } = shiftStateFor(schedule);

    const open = await openSessionFor(userId);
    const populated = open
      ? await CallSession.findById(open._id).populate("lead", "name phone status").lean()
      : null;

    return sendSuccess(res, "Session state", {
      onShift, mode,
      breakEndsAt: breaking?.breakEndsAt ?? null,
      session: populated,
      pendingOutcome,
      breakReturn,
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

    // Dialling tells us nothing about how the call went — the details are owed
    // separately, and the scheduler holds off until they arrive.
    if (action === "called") {
      session.callStartedAt = now;
      session.outcomeStatus = "pending";
    }

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

/**
 * POST /call-automation/sessions/:id/outcome
 * body { callResult, durationSeconds, note } — all three required.
 *
 * Re-posting edits the details: the new values become current and the previous
 * ones stay in outcomeHistory, so an admin can see every version and when it
 * was entered.
 */
export const submitCallOutcome = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { callResult, durationSeconds, note } = req.body as {
      callResult?: string; durationSeconds?: unknown; note?: string;
    };

    if (!callResult || !CALL_RESULTS.includes(callResult as CallResult)) {
      return sendError(res, `callResult must be one of: ${CALL_RESULTS.join(", ")}`, 400);
    }
    const seconds = Number(durationSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return sendError(res, "durationSeconds must be a number of seconds, 0 or more", 400);
    }
    if (!note?.trim()) {
      return sendError(res, "A note is required — say what happened on the call", 400);
    }

    const session = await CallSession.findOne({ _id: req.params.id, user: req.user!.userId });
    if (!session) return sendError(res, "Call session not found", 404);
    if (session.action !== "called") {
      return sendError(res, "Only a call can have call details", 400);
    }

    const now = new Date();
    session.callResult = callResult as CallResult;
    session.callDurationSeconds = Math.round(seconds);
    session.callNote = note.trim();
    session.outcomeStatus = "submitted";
    session.outcomeAt = now;
    session.outcomeSkipReason = undefined;
    session.outcomeHistory = [
      ...(session.outcomeHistory ?? []),
      {
        callResult: callResult as CallResult,
        durationSeconds: Math.round(seconds),
        note: note.trim(),
        recordedAt: now,
        recordedBy: new Types.ObjectId(req.user!.userId),
      },
    ];

    await session.save();
    void notifyAdminsOfCallActivity({ sessionId: session._id.toString(), action: "outcome" });
    return sendSuccess(res, "Call details saved", session);
  } catch (error) { next(error); }
};

/**
 * POST /call-automation/sessions/:id/outcome/skip — body { reason }
 * The way out of a mandatory form. Costs them a reason, and the Call Automation
 * page lists every skipped write-up.
 */
export const skipCallOutcome = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) {
      return sendError(res, "A reason is required when the call details are not filled in", 400);
    }

    const session = await CallSession.findOne({ _id: req.params.id, user: req.user!.userId });
    if (!session) return sendError(res, "Call session not found", 404);
    if (session.outcomeStatus !== "pending") {
      return sendError(res, "This call is not waiting on details", 409);
    }

    session.outcomeStatus = "skipped";
    session.outcomeSkipReason = reason.trim();
    session.outcomeAt = new Date();
    await session.save();

    void notifyAdminsOfCallActivity({ sessionId: session._id.toString(), action: "outcome-skipped" });
    return sendSuccess(res, "Recorded as not filled in", session);
  } catch (error) { next(error); }
};

/** POST /call-automation/break/return — "I'm back" after the break ran out. */
export const confirmBreakReturn = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const session = await awaitingBreakReturnFor(userId);
    if (!session) return sendError(res, "Nothing is waiting on you to come back", 404);

    const now = new Date();
    session.breakReturnedAt = now;
    session.breakReturnHoldSeconds = session.breakReturnPromptedAt
      ? Math.round((now.getTime() - session.breakReturnPromptedAt.getTime()) / 1000)
      : 0;
    session.breakOverrunSeconds = session.breakEndsAt
      ? Math.round((now.getTime() - session.breakEndsAt.getTime()) / 1000)
      : 0;
    await session.save();

    void notifyAdminsOfCallActivity({ sessionId: session._id.toString(), action: "break-returned" });
    return sendSuccess(res, "Welcome back", session);
  } catch (error) { next(error); }
};

/**
 * POST /call-automation/break/extend — body { minutes }
 * Pushes the break out rather than making them claim to be back. The question
 * is cleared so it is asked again when the new end time passes.
 */
export const extendBreak = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const minutes = Number((req.body as { minutes?: unknown }).minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
      return sendError(res, "minutes must be between 1 and 120", 400);
    }

    const userId = req.user!.userId;
    const session = await awaitingBreakReturnFor(userId);
    if (!session) return sendError(res, "You are not on a break that has run out", 404);

    session.breakEndsAt = new Date(Date.now() + minutes * 60_000);
    session.breakMinutes = (session.breakMinutes ?? 0) + minutes;
    session.breakExtensions = (session.breakExtensions ?? 0) + 1;
    session.breakReturnPromptedAt = null;   // ask again when the new time is up
    await session.save();

    void notifyAdminsOfCallActivity({ sessionId: session._id.toString(), action: "break-extended" });
    return sendSuccess(res, `Break extended by ${minutes} min`, session);
  } catch (error) { next(error); }
};
