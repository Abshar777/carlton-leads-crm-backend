import mongoose from "mongoose";
import { Tag } from "../models/Tag.js";
import { Lead } from "../models/Lead.js";

export class TagService {
  async getAllTags() {
    return Tag.find().sort({ name: 1 }).lean();
  }

  async createTag(name: string, color: string, createdBy: string) {
    const existing = await Tag.findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
    if (existing) {
      const err = new Error("A tag with this name already exists") as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    }
    return Tag.create({ name, color, createdBy });
  }

  async updateTag(id: string, updates: { name?: string; color?: string }) {
    if (!mongoose.isValidObjectId(id)) {
      const err = new Error("Invalid tag ID") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    if (updates.name) {
      const existing = await Tag.findOne({
        name: { $regex: new RegExp(`^${updates.name}$`, "i") },
        _id: { $ne: id },
      });
      if (existing) {
        const err = new Error("A tag with this name already exists") as Error & { statusCode: number };
        err.statusCode = 409;
        throw err;
      }
    }

    const tag = await Tag.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
    if (!tag) {
      const err = new Error("Tag not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return tag;
  }

  async deleteTag(id: string) {
    if (!mongoose.isValidObjectId(id)) {
      const err = new Error("Invalid tag ID") as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }

    const tag = await Tag.findByIdAndDelete(id);
    if (!tag) {
      const err = new Error("Tag not found") as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }

    // Remove tag reference from all leads
    await Lead.updateMany({ tags: id }, { $pull: { tags: new mongoose.Types.ObjectId(id) } });

    return tag;
  }
}
