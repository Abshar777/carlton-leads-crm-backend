import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest, IRole } from "../types/index.js";
import { LeadService } from "../services/leadService.js";
import { ExcelService } from "../services/excelService.js";
import { sendSuccess, sendError } from "../utils/response.js";

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
    .enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "interested"])
    .optional(),
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
    .enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "interested"])
    .optional(),
  assignedTo: z.string().optional().nullable(),
});

const updateStatusSchema = z.object({
  status: z.enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "interested"]),
});

const assignLeadSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

const autoAssignSchema = z.object({
  leadIds: z.array(z.string()).optional(),
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

    let assignmentResult = {
      assigned: 0,
      results: [] as { leadId: string; assignedTo: string }[],
    };
    if (createdLeads.length > 0) {
      try {
        const leadIds = (
          createdLeads as Array<{ _id: { toString(): string } }>
        ).map((l) => l._id.toString());
        assignmentResult = await leadService.autoAssignLeads(leadIds);
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

    const data = { ...parsed.data, email: parsed.data.email || undefined };
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

    const result = await leadService.autoAssignLeads(parsed.data.leadIds);
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
      .extend({ status: z.enum(["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "interested"]) })
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
