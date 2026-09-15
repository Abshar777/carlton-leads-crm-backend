import mongoose, { Schema } from "mongoose";

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = typeof DAY_KEYS[number];

/** off = weekly off · full = full day · half = half day */
export type DayMode = "off" | "full" | "half";
export const DAY_MODES: DayMode[] = ["off", "full", "half"];

export interface IWorkSchedule {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  loginTime: string;          // "HH:mm", IST
  logoutTime: string;
  /** Optional break window. Omitted when a shift has no scheduled break. */
  breakStart?: string;
  breakEnd?: string;
  /** When set, "half" days end here instead of logoutTime. */
  halfDayLogoutTime?: string;
  workDays: Record<DayKey, DayMode>;
  /** Minutes of lateness tolerated before a login counts as late. */
  graceMinutes: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeField = (required = false) => ({
  type: String,
  required,
  validate: {
    validator: (v: string | null | undefined) => v == null || v === "" || TIME_RE.test(v),
    message: "Time must be in HH:mm format",
  },
});

const workScheduleSchema = new Schema<IWorkSchedule>(
  {
    name: {
      type: String,
      required: [true, "Schedule name is required"],
      trim: true,
      maxlength: [60, "Name cannot exceed 60 characters"],
      unique: true,
    },
    description:       { type: String, trim: true, maxlength: [300, "Description cannot exceed 300 characters"] },
    loginTime:         timeField(true),
    logoutTime:        timeField(true),
    breakStart:        timeField(),
    breakEnd:          timeField(),
    halfDayLogoutTime: timeField(),
    workDays: {
      type: new Schema(
        DAY_KEYS.reduce(
          (acc, d) => ({ ...acc, [d]: { type: String, enum: DAY_MODES, default: "off" } }),
          {} as Record<DayKey, unknown>,
        ),
        { _id: false },
      ),
      default: () => DAY_KEYS.reduce((a, d) => ({ ...a, [d]: "off" }), {}),
    },
    graceMinutes: { type: Number, default: 0, min: [0, "Grace cannot be negative"], max: [240, "Grace cannot exceed 240 minutes"] },
    isActive:     { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

export const WorkSchedule = mongoose.model<IWorkSchedule>("WorkSchedule", workScheduleSchema);
