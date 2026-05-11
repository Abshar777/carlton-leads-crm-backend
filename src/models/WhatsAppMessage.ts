import mongoose, { Schema } from "mongoose";

export type WAMediaType = "image" | "video" | "document" | "audio" | "sticker";

export interface IWhatsAppMessage {
  lead:             mongoose.Types.ObjectId | null;
  phone:            string;
  direction:        "inbound" | "outbound";
  body:             string;
  messageId:        string;
  senderName:       string;
  agentId?:         mongoose.Types.ObjectId | null;
  connectedUserId?: mongoose.Types.ObjectId | null;
  read:             boolean;
  mediaData?:       string;   // base64-encoded bytes (no disk storage)
  mediaType?:       WAMediaType;
  mimeType?:        string;
  fileName?:        string;
  createdAt:        Date;
}

const whatsAppMessageSchema = new Schema<IWhatsAppMessage>(
  {
    lead:             { type: Schema.Types.ObjectId, ref: "Lead",    default: null, index: true },
    phone:            { type: String,  required: true,  index: true },
    direction:        { type: String,  enum: ["inbound", "outbound"], required: true },
    body:             { type: String,  required: true },
    messageId:        { type: String,  default: "" },
    senderName:       { type: String,  default: "" },
    agentId:          { type: Schema.Types.ObjectId, ref: "User",    default: null },
    connectedUserId:  { type: Schema.Types.ObjectId, ref: "User",    default: null, index: true },
    read:             { type: Boolean, default: false },
    mediaData:        { type: String,  default: null },   // base64
    mediaType:        { type: String,  enum: ["image","video","document","audio","sticker"], default: null },
    mimeType:         { type: String,  default: null },
    fileName:         { type: String,  default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

whatsAppMessageSchema.index({ connectedUserId: 1, phone: 1, createdAt: -1 });
whatsAppMessageSchema.index({ phone: 1, createdAt: -1 });
// Deduplication guard — unique only on real messageIds (inbound have one; outbound are "").
// Uses $gt instead of $ne because MongoDB 7.0+ does not support $ne in partial filter expressions.
whatsAppMessageSchema.index(
  { messageId: 1 },
  { unique: true, partialFilterExpression: { messageId: { $gt: "" } } },
);

export const WhatsAppMessage = mongoose.model<IWhatsAppMessage>("WhatsAppMessage", whatsAppMessageSchema);
