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

/**
 * Pressing "Call Next" dials but says nothing about how the call went, so the
 * session stays "pending" until the caller fills in the details — or explicitly
 * declines, with a reason, which the admin page flags.
 */
export type CallOutcomeStatus = "pending" | "submitted" | "skipped";

export const CALL_OUTCOME_STATUSES: CallOutcomeStatus[] = ["pending", "submitted", "skipped"];

export const CALL_RESULTS = [
  "connected", "noanswer", "busy", "switchedoff", "wrongnumber", "callback",
] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

/** One filling-in of the call details. Edits append rather than overwrite. */
export interface ICallOutcomeEntry {
  callResult: CallResult;
  /** The effective figure — the manual one, kept under the old name. */
  durationSeconds: number;
  /** Measured by the system: Call Next pressed until they were back in the app. */
  autoDurationSeconds?: number;
  /** What the caller typed. Required, so in practice this equals durationSeconds. */
  manualDurationSeconds?: number;
  note: string;
  recordedAt: Date;
  recordedBy: mongoose.Types.ObjectId;
}

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

  // ── Coming back from a break ──────────────────────────────────────────────
  /** Set once the break time is up and we start asking whether they are back. */
  breakReturnPromptedAt?: Date | null;
  /** When they confirmed. Null while the question is still on screen. */
  breakReturnedAt?: Date | null;
  /** How long the "are you back?" popup sat there before they answered. */
  breakReturnHoldSeconds?: number;
  /** How far past breakEndsAt they actually confirmed. */
  breakOverrunSeconds?: number;
  /** Closed without an answer, so it cannot block prompts indefinitely. */
  breakReturnClosedAt?: Date | null;
  /** How many times they pushed the break out rather than coming back. */
  breakExtensions?: number;

  // ── Call outcome (action "called" only) ───────────────────────────────────
  /** When they pressed Call Next — the clock the auto-measured duration uses. */
  callStartedAt?: Date | null;
  outcomeStatus?: CallOutcomeStatus | null;
  /** Latest values; the full trail lives in outcomeHistory. */
  callResult?: CallResult | null;
  /** Effective duration — the entered one. Unchanged name so reports keep working. */
  callDurationSeconds?: number;
  /** System-measured: Call Next pressed until they were back in the app. */
  autoDurationSeconds?: number;
  /** What the caller typed in. */
  manualDurationSeconds?: number;
  callNote?: string;
  /** When the details were last filled in or edited. */
  outcomeAt?: Date | null;
  /** Mandatory when outcomeStatus is "skipped". */
  outcomeSkipReason?: string;
  outcomeHistory?: ICallOutcomeEntry[];

  createdAt: Date;
  updatedAt: Date;
}

const outcomeEntrySchema = new Schema<ICallOutcomeEntry>(
  {
    callResult:            { type: String, enum: CALL_RESULTS, required: true },
    durationSeconds:       { type: Number, required: true, min: 0 },
    autoDurationSeconds:   { type: Number, min: 0 },
    manualDurationSeconds: { type: Number, min: 0 },
    note:            { type: String, required: true, trim: true, maxlength: [2000, "Note cannot exceed 2000 characters"] },
    recordedAt:      { type: Date, default: Date.now },
    recordedBy:      { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false },
);

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

    breakReturnPromptedAt:  { type: Date, default: null },
    breakReturnedAt:        { type: Date, default: null },
    breakReturnHoldSeconds: { type: Number, min: 0 },
    breakOverrunSeconds:    { type: Number },
    breakReturnClosedAt:    { type: Date, default: null },
    breakExtensions:        { type: Number, default: 0, min: 0 },

    callStartedAt:       { type: Date, default: null },
    outcomeStatus:       { type: String, enum: CALL_OUTCOME_STATUSES, default: null },
    callResult:          { type: String, enum: CALL_RESULTS, default: null },
    callDurationSeconds:   { type: Number, min: 0 },
    autoDurationSeconds:   { type: Number, min: 0 },
    manualDurationSeconds: { type: Number, min: 0 },
    callNote:            { type: String, trim: true, maxlength: [2000, "Note cannot exceed 2000 characters"] },
    outcomeAt:           { type: Date, default: null },
    outcomeSkipReason:   { type: String, trim: true, maxlength: [500, "Reason cannot exceed 500 characters"] },
    outcomeHistory:      { type: [outcomeEntrySchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

// The scheduler asks "does this user have an open prompt?" every minute.
callSessionSchema.index({ user: 1, action: 1, promptedAt: -1 });

// ...and "are they still owing me call details?" just as often.
callSessionSchema.index({ user: 1, outcomeStatus: 1 });

// "is anyone overdue back from a break?" runs on every tick too.
callSessionSchema.index({ action: 1, breakEndsAt: 1, breakReturnedAt: 1 });

export const CallSession = mongoose.model<ICallSession>("CallSession", callSessionSchema);
