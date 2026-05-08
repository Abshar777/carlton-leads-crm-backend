import { Schema, model, Types, Document } from "mongoose";
import { randomUUID } from "crypto";

export interface IAiMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export type AiContextType = "lead" | "team" | "report";

export interface IAiMemory extends Document {
  contextType: AiContextType;
  contextId:   string;
  sessionId:   string;
  sessionName: string;
  user:        Types.ObjectId;
  messages:    IAiMessage[];
  createdAt:   Date;
  updatedAt:   Date;
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
    sessionId:   { type: String, required: true, default: () => randomUUID() },
    sessionName: { type: String, default: "New Chat", maxlength: 80 },
    user:        { type: Schema.Types.ObjectId, ref: "User", required: true },
    messages:    { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

// Primary unique constraint: one document per (user, sessionId)
aiMemorySchema.index({ user: 1, sessionId: 1 }, { unique: true });
// Secondary index for context queries (backward compat, non-unique now)
aiMemorySchema.index({ contextType: 1, contextId: 1, user: 1 });

export const AiMemory = model<IAiMemory>("AiMemory", aiMemorySchema);
