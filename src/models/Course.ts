import mongoose, { Schema } from "mongoose";
import type { ICourse } from "../types/index.js";

const courseSchema = new Schema<ICourse>(
  {
    name: {
      type: String,
      required: [true, "Course name is required"],
      trim: true,
      maxlength: [150, "Course name cannot exceed 150 characters"],
      unique: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters"],
    },
    amount: {
      type: Number,
      required: [true, "Course amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

courseSchema.index({ name: 1 }, { unique: true });
courseSchema.index({ status: 1 });

export const Course = mongoose.model<ICourse>("Course", courseSchema);
