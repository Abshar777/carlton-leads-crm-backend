import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest, IRole } from "../types/index.js";
import { LeadService } from "../services/leadService.js";
import { ExcelService } from "../services/excelService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { sendPushToUser } from "../services/pushService.js";
import { emitToUser } from "../socket.js";
import { Lead } from "../models/Lead.js";
import mongoose from "mongoose";

const leadService = new LeadService();
const excelService = new ExcelService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createLeadSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().min(1, "Phone is required").max(20),
  source: z.string().max(100).optional(),
  course: z.string().optional().nullable(),
  status: z
    .enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "partialbooking", "interested", "rnr", "callback", "whatsapp", "student"])
    .optional(),
  team: z.string().optional().nullable(),
  assignedTo: z.string().optional(),
});

const updateLeadSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z
    .string()
    .email("Invalid email")
    .optional()
    .or(z.literal(""))
    .nullable(),
  phone: z.string().min(1).max(20).optional(),
  source: z.string().max(100).optional().nullable(),
  course: z.string().optional().nullable(),
  status: z
    .enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "partialbooking", "interested", "rnr", "callback", "whatsapp", "student"])
    .optional(),
  assignedTo: z.string().optional().nullable(),
});

const updateStatusSchema = z.object({
  status: z.enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "partialbooking", "interested", "rnr", "callback", "whatsapp", "student"]),
});

const assignLeadSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

const autoAssignSchema = z.object({
  leadIds: z.array(z.string()).optional(),
  teamIds: z.array(z.string()).optional(),
});

const noteSchema = z.object({
  content: z.string().min(1, "Note content is required").max(2000),
});

// ─── Lead Controllers ─────────────────────────────────────────────────────────

export const uploadLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      sendError(res, "No file uploaded", 400);
      return;
    }

    const allowedMimetypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
      "application/csv",
    ];
    if (
      !allowedMimetypes.includes(file.mimetype) &&
      !file.originalname.match(/\.(xlsx|xls|csv)$/i)
    ) {
      sendError(
        res,
        "Invalid file type. Please upload an xlsx, xls, or csv file.",
        400,
      );
      return;
    }

    const parseResult = await excelService.parseFile(
      file.buffer,
      file.mimetype,
    );

    if (parseResult.valid.length === 0 && parseResult.invalid.length > 0) {
      sendError(res, "No valid leads found in the file", 400, {
        invalid: parseResult.invalid,
      });
      return;
    }

    const reporterId = req.user!.userId;
    let createdLeads: unknown[] = [];

    if (parseResult.valid.length > 0) {
      createdLeads = await leadService.bulkCreateLeads(
        parseResult.valid,
        reporterId,
      );
    }

    // teamIds may arrive as a JSON string in the multipart form body
    let teamIds: string[] | undefined;
    try {
      if (req.body.teamIds) {
        const parsed = JSON.parse(req.body.teamIds as string);
        if (Array.isArray(parsed)) teamIds = parsed.filter((id) => typeof id === "string");
      }
    } catch {
      // malformed — treat as "all teams"
    }

    let assignmentResult = {
      assigned: 0,
      results: [] as { leadId: string; assignedTo: string }[],
    };
    if (createdLeads.length > 0) {
      try {
        const leadIds = (
          createdLeads as Array<{ _id: { toString(): string } }>
        ).map((l) => l._id.toString());
        assignmentResult = await leadService.autoAssignLeads(leadIds, teamIds);
      } catch {
        // Auto-assign failure should not block the upload
      }
    }

    sendSuccess(
      res,
      "Leads uploaded successfully",
      {
        total: parseResult.valid.length + parseResult.invalid.length,
        created: createdLeads.length,
        assigned: assignmentResult.assigned,
        invalid: parseResult.invalid.length,
        invalidDetails: parseResult.invalid,
      },
      201,
    );
  } catch (error) {
    next(error);
  }
};

export const createLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = createLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const data = {
      ...parsed.data,
      email:      parsed.data.email  || undefined,
      team:       parsed.data.team   || undefined,
      assignedTo: parsed.data.assignedTo || undefined,
    };
    // Auto-assign to the creator only when no explicit assignee was chosen
    if (!data.assignedTo) {
      data.assignedTo = req.user!.userId;
    }
    const lead = await leadService.createLead(data, req.user!.userId);
    sendSuccess(res, "Lead created successfully", lead, 201);
  } catch (error) {
    next(error);
  }
};

export const getLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const role = req.user?.role as IRole | undefined;
    const { leads, pagination } = await leadService.getLeads(
      req.query as Record<string, string>,
      req.user?.userId,
      role,
    );
    sendSuccess(res, "Leads retrieved successfully", leads, 200, pagination);
  } catch (error) {
    next(error);
  }
};

export const getLeadById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await leadService.getLeadById(req.params.id);
    sendSuccess(res, "Lead retrieved successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const updateLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const data: Record<string, unknown> = { ...parsed.data };
    if (data.email === "" || data.email === null) data.email = undefined;

    const lead = await leadService.updateLead(
      req.params.id,
      data as Parameters<typeof leadService.updateLead>[1],
      req.user!.userId,
    );
    sendSuccess(res, "Lead updated successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const updateLeadStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.updateLeadStatus(
      req.params.id,
      parsed.data.status,
      req.user!.userId,
    );
    sendSuccess(res, "Lead status updated successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const assignLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = assignLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.assignLead(
      req.params.id,
      parsed.data.userId,
      req.user!.userId,
    );

    // ── Notify the assigned user ───────────────────────────────────────────────
    const assignedUserId = parsed.data.userId;
    const leadDoc = lead as unknown as { name?: string; _id?: { toString(): string } };
    const leadId  = leadDoc?._id?.toString() ?? req.params.id;
    const leadName = leadDoc?.name ?? "a new lead";
    const notifPayload = {
      title: "New Lead Assigned",
      body: `You have been assigned the lead: ${leadName}`,
      tag: `lead-assigned-${leadId}`,
      url: `/leads/${leadId}`,
      data: { type: "lead_assigned", leadId },
    };
    // Real-time socket event
    emitToUser(assignedUserId, "notification", {
      ...notifPayload,
      createdAt: new Date().toISOString(),
    });
    // Web push (fire-and-forget)
    sendPushToUser(assignedUserId, notifPayload).catch(() => null);

    sendSuccess(res, "Lead assigned successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const deleteLead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await leadService.deleteLead(req.params.id);
    sendSuccess(res, result.message);
  } catch (error) {
    next(error);
  }
};

export const getLeadsByUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { leads, pagination } = await leadService.getLeadsByUser(
      req.params.userId,
      req.query as Record<string, string>,
    );
    sendSuccess(
      res,
      "User leads retrieved successfully",
      leads,
      200,
      pagination,
    );
  } catch (error) {
    next(error);
  }
};

export const getUserLeadStats = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const stats = await leadService.getUserLeadStats(req.params.userId);
    sendSuccess(res, "User lead stats retrieved successfully", stats);
  } catch (error) {
    next(error);
  }
};

export const autoAssignLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = autoAssignSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const result = await leadService.autoAssignLeads(parsed.data.leadIds, parsed.data.teamIds);
    sendSuccess(
      res,
      `Successfully assigned ${result.assigned} lead(s)`,
      result,
    );
  } catch (error) {
    next(error);
  }
};

// ─── Note Controllers ─────────────────────────────────────────────────────────

export const addNote = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.addNote(
      req.params.id,
      parsed.data.content,
      req.user!.userId,
    );
    sendSuccess(res, "Note added successfully", lead, 201);
  } catch (error) {
    next(error);
  }
};

export const updateNote = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "Validation failed",
        400,
        parsed.error.flatten().fieldErrors,
      );
      return;
    }

    const lead = await leadService.updateNote(
      req.params.id,
      req.params.noteId,
      parsed.data.content,
      req.user!.userId,
    );
    sendSuccess(res, "Note updated successfully", lead);
  } catch (error) {
    next(error);
  }
};

export const deleteNote = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const role = req.user?.role as IRole | undefined;
    const isSuperAdmin =
      role?.isSystemRole === true && role?.roleName === "Super Admin";

    const lead = await leadService.deleteNote(
      req.params.id,
      req.params.noteId,
      req.user!.userId,
      isSuperAdmin,
    );
    sendSuccess(res, "Note deleted successfully", lead);
  } catch (error) {
    next(error);
  }
};

// ─── Team assignment ───────────────────────────────────────────────────────────

const assignTeamSchema = z.object({ teamId: z.string().min(1, "Team ID is required") });

export const assignLeadToTeam = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = assignTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await leadService.assignLeadToTeam(
      req.params.id,
      parsed.data.teamId,
      req.user!.userId,
    );
    sendSuccess(res, "Lead assigned to team successfully", lead);
  } catch (error) {
    next(error);
  }
};

// ─── Bulk Operations ──────────────────────────────────────────────────────────

const bulkLeadIdsSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, "At least one lead ID is required"),
});

export const bulkUpdateLeadStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ status: z.enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "partialbooking", "interested", "rnr", "callback", "whatsapp", "student"]) })
      .safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await leadService.bulkUpdateStatus(
      parsed.data.leadIds,
      parsed.data.status,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) status updated`, result);
  } catch (error) {
    next(error);
  }
};

export const bulkDeleteLeads = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = bulkLeadIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await leadService.bulkDelete(parsed.data.leadIds);
    sendSuccess(res, `${result.deleted} lead(s) deleted`, result);
  } catch (error) {
    next(error);
  }
};

export const bulkAssignLeadsToTeam = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ teamId: z.string().min(1, "Team ID is required") })
      .safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const result = await leadService.bulkAssignToTeam(
      parsed.data.leadIds,
      parsed.data.teamId,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) assigned to team`, result);
  } catch (error) {
    next(error);
  }
};

export const transferLeadToTeam = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = assignTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await leadService.transferLeadToTeam(
      req.params.id,
      parsed.data.teamId,
      req.user!.userId,
    );
    sendSuccess(res, "Lead transferred to team successfully", lead);
  } catch (error) {
    next(error);
  }
};

// ─── Reminder Controllers ─────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

const reminderSchema = z.object({
  title:    z.string().max(200).optional(),
  note:     z.string().max(1000).optional(),
  remindAt: z
    .string()
    .min(1, "remindAt is required")
    .refine((val) => {
      const d = new Date(val);
      return !isNaN(d.getTime());
    }, "Invalid date/time format")
    .refine((val) => {
      const d = new Date(val);
      // Allow a 60-second grace window so a reminder set "right now" isn't
      // rejected due to slight clock drift between client and server.
      const nowIST = new Date(Date.now() - IST_OFFSET_MS);
      return d.getTime() > nowIST.getTime() - 60_000;
    }, "Reminder time must be in the future (IST)"),
  isDone:   z.boolean().optional(),
});

/** GET /leads/reminders/mine — all active reminders for the current user */
export const getMyReminders = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const leads = await Lead.find(
      { "reminders.createdBy": new mongoose.Types.ObjectId(userId) },
      { name: 1, phone: 1, email: 1, status: 1, assignedTo: 1, team: 1, reminders: 1 },
    )
      .populate("assignedTo", "name email")
      .populate("team", "name")
      .lean();

    // flatten: one entry per reminder that belongs to this user
    const items = leads.flatMap((lead) =>
      (lead.reminders ?? [])
        .filter((r) => r.createdBy?.toString() === userId)
        .map((r) => ({
          ...r,
          lead: {
            _id: lead._id,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            status: lead.status,
            assignedTo: lead.assignedTo,
            team: lead.team,
          },
        })),
    );

    // Sort by remindAt ascending
    type ReminderItem = (typeof items)[number] & { remindAt: Date };
    (items as ReminderItem[]).sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());

    sendSuccess(res, "Reminders fetched", items);
  } catch (error) {
    next(error);
  }
};

/** GET /leads/reminders/count — count of undone future reminders */
export const getMyReminderCount = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const leads = await Lead.find(
      { "reminders.createdBy": new mongoose.Types.ObjectId(userId) },
      { reminders: 1 },
    ).lean();

    let count = 0;
    for (const lead of leads) {
      count += (lead.reminders ?? []).filter(
        (r) => r.createdBy?.toString() === userId && !r.isDone,
      ).length;
    }
    sendSuccess(res, "Count fetched", { count });
  } catch (error) {
    next(error);
  }
};

/** POST /leads/:id/reminders */
export const addReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = reminderSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    lead.reminders.push({
      title:     parsed.data.title,
      note:      parsed.data.note,
      remindAt:  new Date(parsed.data.remindAt),
      createdBy: new mongoose.Types.ObjectId(req.user!.userId),
      isDone:    false,
    } as never);

    await lead.save();
    const added = lead.reminders[lead.reminders.length - 1];
    sendSuccess(res, "Reminder added", added, 201);
  } catch (error) {
    next(error);
  }
};

/** PUT /leads/:id/reminders/:reminderId */
export const updateReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = reminderSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const reminder = lead.reminders.id(req.params.reminderId);
    if (!reminder) { sendError(res, "Reminder not found", 404); return; }

    if (parsed.data.title    !== undefined) reminder.title    = parsed.data.title;
    if (parsed.data.note     !== undefined) reminder.note     = parsed.data.note;
    if (parsed.data.remindAt !== undefined) reminder.remindAt = new Date(parsed.data.remindAt);
    if (parsed.data.isDone   !== undefined) reminder.isDone   = parsed.data.isDone;

    await lead.save();
    sendSuccess(res, "Reminder updated", reminder);
  } catch (error) {
    next(error);
  }
};

/** DELETE /leads/:id/reminders/:reminderId */
export const deleteReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const reminder = lead.reminders.id(req.params.reminderId);
    if (!reminder) { sendError(res, "Reminder not found", 404); return; }

    reminder.deleteOne();
    await lead.save();
    sendSuccess(res, "Reminder deleted");
  } catch (error) {
    next(error);
  }
};

// ─── Payment Controllers ──────────────────────────────────────────────────────

const paymentBodySchema = z.object({
  amount: z.number().min(0, "Amount cannot be negative"),
  note:   z.string().max(500).optional(),
  paidAt: z.string().min(1, "paidAt is required"),
});

/** POST /leads/:id/payments */
export const addPayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = paymentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    lead.payments.push({
      amount:  parsed.data.amount,
      note:    parsed.data.note,
      paidAt:  new Date(parsed.data.paidAt),
      addedBy: new mongoose.Types.ObjectId(req.user!.userId),
    } as never);

    await lead.save();
    const added = lead.payments[lead.payments.length - 1];
    sendSuccess(res, "Payment recorded", added, 201);
  } catch (error) {
    next(error);
  }
};

/** PUT /leads/:id/payments/:paymentId */
export const updatePayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = paymentBodySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const payment = lead.payments.id(req.params.paymentId);
    if (!payment) { sendError(res, "Payment not found", 404); return; }

    if (parsed.data.amount !== undefined) payment.amount = parsed.data.amount;
    if (parsed.data.note   !== undefined) payment.note   = parsed.data.note;
    if (parsed.data.paidAt !== undefined) payment.paidAt = new Date(parsed.data.paidAt);

    await lead.save();
    sendSuccess(res, "Payment updated", payment);
  } catch (error) {
    next(error);
  }
};

// ─── Call Not Connected ───────────────────────────────────────────────────────

const callNotConnectedSchema = z.object({
  action: z.enum(["increment", "decrement"]),
});

/** PATCH /leads/:id/call-not-connected */
export const updateCallNotConnected = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = callNotConnectedSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const current = lead.callNotConnected ?? 0;
    const newCount = parsed.data.action === "increment"
      ? current + 1
      : Math.max(0, current - 1);

    const update: Record<string, unknown> = { callNotConnected: newCount };
    if (parsed.data.action === "increment") {
      update.callCount = (lead.callCount ?? 0) + 1;
    }
    await Lead.updateOne({ _id: lead._id }, { $set: update });
    sendSuccess(res, "Call not connected count updated", { callNotConnected: newCount, callCount: update.callCount ?? lead.callCount ?? 0 });
  } catch (error) {
    next(error);
  }
};

/** PATCH /leads/:id/call-count */
export const updateCallCount = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = callNotConnectedSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const current = lead.callCount ?? 0;
    const newCount = parsed.data.action === "increment"
      ? current + 1
      : Math.max(0, current - 1);

    await Lead.updateOne({ _id: lead._id }, { $set: { callCount: newCount } });
    sendSuccess(res, "Call count updated", { callCount: newCount });
  } catch (error) {
    next(error);
  }
};

/** DELETE /leads/:id/payments/:paymentId */
export const deletePayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) { sendError(res, "Lead not found", 404); return; }

    const payment = lead.payments.id(req.params.paymentId);
    if (!payment) { sendError(res, "Payment not found", 404); return; }

    payment.deleteOne();
    await lead.save();
    sendSuccess(res, "Payment deleted");
  } catch (error) {
    next(error);
  }
};
