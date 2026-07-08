import mongoose, { Schema } from "mongoose";
import type { ITag } from "../types/index.js";

const tagSchema = new Schema<ITag>(
  {
    name: {
      type: String,
      required: [true, "Tag name is required"],
      trim: true,
      maxlength: [50, "Tag name cannot exceed 50 characters"],
    },
    color: {
      type: String,
      required: [true, "Tag color is required"],
      match: [/^#[0-9A-Fa-f]{6}$/, "Color must be a valid hex code"],
      default: "#6b7280",
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Creator is required"],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

tagSchema.index({ name: 1 });
tagSchema.index({ createdBy: 1 });

export const Tag = mongoose.model<ITag>("Tag", tagSchema);
