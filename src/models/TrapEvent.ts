import mongoose, { Schema } from "mongoose";

export type TrapAction =
  | "download_leads"
  | "copy_phone"
  | "print_attempt"
  | "screenshot_attempt"
  | "whatsapp_share";

export interface ITrapEvent {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  action: TrapAction;
  leadId?: mongoose.Types.ObjectId;
  leadName?: string;
  phoneNumber?: string;
  page?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const trapEventSchema = new Schema<ITrapEvent>(
  {
    user:        { type: Schema.Types.ObjectId, ref: "User", required: true },
    action:      { type: String, enum: ["download_leads", "copy_phone", "print_attempt", "screenshot_attempt", "whatsapp_share"], required: true },
    leadId:      { type: Schema.Types.ObjectId, ref: "Lead" },
    leadName:    { type: String },
    phoneNumber: { type: String },
    page:        { type: String },
    ipAddress:   { type: String },
    userAgent:   { type: String },
  },
  { timestamps: true }
);

export const TrapEvent = mongoose.model<ITrapEvent>("TrapEvent", trapEventSchema);
