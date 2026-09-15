import { z } from "zod";

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    "Password must contain at least one uppercase letter, one lowercase letter, and one number"
  );

export const createUserSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email address"),
  password: passwordSchema,
  role: z.string().min(1, "Role is required"),
  designation: z.string().max(100).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email("Invalid email address").optional(),
  password: passwordSchema.optional(),
  role: z.string().optional(),
  designation: z.string().max(100).optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ─── Work schedule ────────────────────────────────────────────────────────────

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeStr = z.string().regex(TIME, "Time must be in HH:mm format");

/** Minutes since midnight, for ordering checks within a day. */
const mins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

const workDaySchema = z
  .object({
    enabled:    z.boolean(),
    loginTime:  timeStr.optional().or(z.literal("")),
    breakStart: timeStr.optional().or(z.literal("")),
    breakEnd:   timeStr.optional().or(z.literal("")),
    logoutTime: timeStr.optional().or(z.literal("")),
  })
  .superRefine((d, ctx) => {
    if (!d.enabled) return;                       // a day off needs no times
    if (!d.loginTime || !d.logoutTime) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A working day needs a login and a logout time" });
      return;
    }
    // A break is optional, but if given it must be a valid window inside the day.
    // Ordering across midnight is deliberately NOT enforced — overnight shifts
    // (22:00 -> 06:00) are allowed.
    if (d.breakStart && !d.breakEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A break needs both a start and an end" });
    }
    if (d.breakEnd && !d.breakStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A break needs both a start and an end" });
    }
    if (d.breakStart && d.breakEnd && mins(d.breakEnd) <= mins(d.breakStart)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Break end must be after break start" });
    }
  });

export const workScheduleSchema = z.object({
  workSchedule: z
    .object({
      mon: workDaySchema, tue: workDaySchema, wed: workDaySchema, thu: workDaySchema,
      fri: workDaySchema, sat: workDaySchema, sun: workDaySchema,
    })
    .nullable(),
});

export type WorkScheduleInput = z.infer<typeof workScheduleSchema>;
