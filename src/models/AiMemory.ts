import { Schema, model, Types, Document } from "mongoose";

export interface IAiMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export type AiContextType = "lead" | "team" | "report";

export interface IAiMemory extends Document {
  contextType: AiContextType;
  contextId: string;   // leadId / teamId / "global"
  user: Types.ObjectId;
  messages: IAiMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IAiMessage>(
  {
    role:      { type: String, enum: ["user", "assistant"], required: true },
    content:   { type: String, required: true, maxlength: 10000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const aiMemorySchema = new Schema<IAiMemory>(
  {
    contextType: { type: String, enum: ["lead", "team", "report"], required: true },
    contextId:   { type: String, required: true },
    user:        { type: Schema.Types.ObjectId, ref: "User", required: true },
    messages:    { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

// One thread per context per user
aiMemorySchema.index({ contextType: 1, contextId: 1, user: 1 }, { unique: true });

export const AiMemory = model<IAiMemory>("AiMemory", aiMemorySchema);
