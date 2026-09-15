import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";
import type { IUser } from "../types/index.js";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeField = {
  type: String,
  validate: {
    validator: (v: string | null | undefined) => v == null || v === "" || TIME_RE.test(v),
    message: "Time must be in HH:mm format",
  },
};

const workDaySchema = new Schema(
  {
    enabled:    { type: Boolean, default: false },
    loginTime:  timeField,
    breakStart: timeField,
    breakEnd:   timeField,
    logoutTime: timeField,
  },
  { _id: false },
);

const workScheduleSchema = new Schema(
  {
    mon: { type: workDaySchema, default: () => ({ enabled: false }) },
    tue: { type: workDaySchema, default: () => ({ enabled: false }) },
    wed: { type: workDaySchema, default: () => ({ enabled: false }) },
    thu: { type: workDaySchema, default: () => ({ enabled: false }) },
    fri: { type: workDaySchema, default: () => ({ enabled: false }) },
    sat: { type: workDaySchema, default: () => ({ enabled: false }) },
    sun: { type: workDaySchema, default: () => ({ enabled: false }) },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: [true, "Role is required"],
    },
    designation: {
      type: String,
      trim: true,
      maxlength: [100, "Designation cannot exceed 100 characters"],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    /**
     * Optional per-weekday work schedule. Times are "HH:mm" strings read as IST —
     * deliberately not Dates, which would drift with timezone and make "09:30"
     * ambiguous. null means this user has no schedule, which is the default.
     */
    workSchedule: {
      type: workScheduleSchema,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Hash password before save
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare passwords
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ status: 1 });

export const User = mongoose.model<IUser>("User", userSchema);
