import mongoose, { Schema } from "mongoose";

export interface IWhatsAppSettings {
  userId:           mongoose.Types.ObjectId;
  autoCreateLeads:  boolean;
  createdAt:        Date;
  updatedAt:        Date;
}

const whatsAppSettingsSchema = new Schema<IWhatsAppSettings>(
  {
    userId:          { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    autoCreateLeads: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const WhatsAppSettings = mongoose.model<IWhatsAppSettings>(
  "WhatsAppSettings",
  whatsAppSettingsSchema
);
