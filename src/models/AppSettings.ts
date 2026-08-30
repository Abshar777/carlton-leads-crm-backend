import mongoose, { Schema, Document } from "mongoose";

export interface IAppSettings extends Document {
  workflowEnabled: boolean;
}

const appSettingsSchema = new Schema<IAppSettings>(
  {
    workflowEnabled: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);

export const AppSettings = mongoose.model<IAppSettings>("AppSettings", appSettingsSchema);

/** Always returns the single settings document, creating it if it doesn't exist. */
export async function getOrCreateSettings(): Promise<IAppSettings> {
  let doc = await AppSettings.findOne();
  if (!doc) doc = await AppSettings.create({ workflowEnabled: false });
  return doc;
}
