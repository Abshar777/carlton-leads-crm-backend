import mongoose, { Schema } from "mongoose";

export type LoginEventType = "login" | "logout";

export interface ILoginEvent {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  type: LoginEventType;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const loginEventSchema = new Schema<ILoginEvent>(
  {
    user:       { type: Schema.Types.ObjectId, ref: "User", required: true },
    type:       { type: String, enum: ["login", "logout"], required: true },
    ipAddress:  { type: String },
    userAgent:  { type: String },
  },
  { timestamps: true }
);

export const LoginEvent = mongoose.model<ILoginEvent>("LoginEvent", loginEventSchema);
