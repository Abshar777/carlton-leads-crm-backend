import mongoose, { Schema, type Document } from "mongoose";

export interface ITeamMessage extends Document {
  team:      mongoose.Types.ObjectId;
  author:    mongoose.Types.ObjectId;
  content:   string;
  createdAt: Date;
  updatedAt: Date;
}

const teamMessageSchema = new Schema<ITeamMessage>(
  {
    team:    { type: Schema.Types.ObjectId, ref: "Team", required: true, index: true },
    author:  { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: {
      type:      String,
      required:  [true, "Message content is required"],
      trim:      true,
      maxlength: [1000, "Message cannot exceed 1000 characters"],
    },
  },
  { timestamps: true },
);

teamMessageSchema.index({ team: 1, createdAt: -1 });

export const TeamMessage = mongoose.model<ITeamMessage>("TeamMessage", teamMessageSchema);
