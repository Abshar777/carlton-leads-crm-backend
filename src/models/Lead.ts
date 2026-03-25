import mongoose, { Schema } from "mongoose";
import type { ILead, ILeadNote, IActivityLog } from "../types/index.js";

// ─── Note Sub-Schema ──────────────────────────────────────────────────────────
const leadNoteSchema = new Schema<ILeadNote & { createdAt: Date; updatedAt: Date }>(
  {
    content: {
      type: String,
      required: [true, "Note content is required"],
      trim: true,
      maxlength: [2000, "Note cannot exceed 2000 characters"],
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Note author is required"],
    },
  },
  {
    timestamps: true,
    _id: true,
  }
);

// ─── Activity Log Sub-Schema ──────────────────────────────────────────────────
const activityLogSchema = new Schema<IActivityLog>(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "lead_created",
        "lead_updated",
        "status_changed",
        "lead_assigned",
        "team_assigned",
        "note_added",
        "note_updated",
        "note_deleted",
      ],
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    changes: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

// ─── Lead Schema ──────────────────────────────────────────────────────────────
const leadSchema = new Schema<ILead>(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    phone: {
      type: String,
      required: [true, "Phone is required"],
      trim: true,
      maxlength: [20, "Phone cannot exceed 20 characters"],
    },
    source: {
      type: String,
      trim: true,
      maxlength: [100, "Source cannot exceed 100 characters"],
    },
    course: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      default: null,
    },
    status: {
      type: String,
      enum: ["new", "assigned", "followup", "closed", "rejected", "cnc", "booking", "interested"],
      default: "new",
    },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    team: {
      type: Schema.Types.ObjectId,
      ref: "Team",
      default: null,
    },
    reporter: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Reporter is required"],
    },
    notes: {
      type: [leadNoteSchema],
      default: [],
    },
    activityLogs: {
      type: [activityLogSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

leadSchema.index({ course: 1 });

// Sparse unique index on email (allows multiple nulls)
leadSchema.index({ email: 1 }, { unique: true, sparse: true });
leadSchema.index({ status: 1 });
leadSchema.index({ assignedTo: 1 });
leadSchema.index({ team: 1 });
leadSchema.index({ reporter: 1 });
leadSchema.index({ createdAt: -1 });

export const Lead = mongoose.model<ILead>("Lead", leadSchema);
