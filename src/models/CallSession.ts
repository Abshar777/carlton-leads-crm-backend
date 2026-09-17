import mongoose, { Schema } from "mongoose";

/**
 * One call prompt shown to a user, and what they did about it.
 *
 * Every prompt is recorded — including ones that expired unanswered — so the
 * Call Automation page can report on holds and rejections from real rows rather
 * than inferring them from activity logs.
 */
export type CallSessionAction = "called" | "updated" | "rejected" | "break" | "expired";

export const CALL_SESSION_ACTIONS: CallSessionAction[] = [
  "called", "updated", "rejected", "break", "expired",
];

export interface ICallSession {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  /** The lead offered. Absent for a break, which is not about a specific lead. */
  lead?: mongoose.Types.ObjectId | null;
  promptedAt: Date;
  respondedAt?: Date | null;
  action?: CallSessionAction | null;
  /** Mandatory when action is "rejected". */
  rejectReason?: string;
  /** respondedAt - promptedAt, stored so "held over N minutes" is a plain query. */
  holdSeconds?: number;
  breakMinutes?: number;
  breakEndsAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const callSessionSchema = new Schema<ICallSession>(
  {
    user:         { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    lead:         { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    promptedAt:   { type: Date, default: Date.now, index: true },
    respondedAt:  { type: Date, default: null },
    action:       { type: String, enum: CALL_SESSION_ACTIONS, default: null },
    rejectReason: { type: String, trim: true, maxlength: [500, "Reason cannot exceed 500 characters"] },
    holdSeconds:  { type: Number, min: 0 },
    breakMinutes: { type: Number, min: 0 },
    breakEndsAt:  { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// The scheduler asks "does this user have an open prompt?" every minute.
callSessionSchema.index({ user: 1, action: 1, promptedAt: -1 });

export const CallSession = mongoose.model<ICallSession>("CallSession", callSessionSchema);
