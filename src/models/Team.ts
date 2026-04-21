import mongoose, { Schema } from "mongoose";
import type { ITeam } from "../types/index.js";

const teamSettingsSchema = new Schema(
  {
    autoAssign: { type: Boolean, default: false },
    splitMode: { type: String, enum: ["round_robin", "equal_load"], default: "round_robin" },
    roundRobinIndex: { type: Number, default: 0 },
    includedMembers: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { _id: false }
);

const teamSchema = new Schema<ITeam>(
  {
    name: {
      type: String,
      required: [true, "Team name is required"],
      trim: true,
      unique: true,
      maxlength: [100, "Team name cannot exceed 100 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [300, "Description cannot exceed 300 characters"],
    },
    leaders: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    // Members marked inactive for auto-assignment within this team (team-level, not global)
    inactiveMembers: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    settings: {
      type: teamSettingsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true, versionKey: false }
);

teamSchema.index({ name: 1 });
teamSchema.index({ status: 1 });

export const Team = mongoose.model<ITeam>("Team", teamSchema);
