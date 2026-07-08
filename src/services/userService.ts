import { User } from "../models/User.js";
import { Role } from "../models/Role.js";
import { Team } from "../models/Team.js";
import type { CreateUserInput, UpdateUserInput } from "../validations/userValidation.js";
import type { IRole, PaginationQuery } from "../types/index.js";
import { buildPagination } from "../utils/response.js";
import { signAccessToken } from "../utils/jwt.js";

export class UserService {
  async createUser(input: CreateUserInput) {
    const existingUser = await User.findOne({ email: input.email.toLowerCase() });
    if (existingUser) {
      throw Object.assign(new Error("Email already exists"), { statusCode: 409 });
    }

    const role = await Role.findById(input.role);
    if (!role) {
      throw Object.assign(new Error("Role not found"), { statusCode: 404 });
    }

    const user = await User.create({ ...input, email: input.email.toLowerCase() });
    return User.findById(user._id).populate("role");
  }

  async getUsers(query: PaginationQuery) {
    const page = Math.max(1, parseInt(query.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "10", 10)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (query.search) {
      const regex = new RegExp(query.search, "i");
      filter.$or = [{ name: regex }, { email: regex }, { designation: regex }];
    }

    // Filter by status
    if (query.status && ["active", "inactive"].includes(query.status)) {
      filter.status = query.status;
    }

    // Filter by role
    if (query.role) {
      filter.role = query.role;
    }

    // Filter by team — find users who are leaders/members of the given team
    if (query.team) {
      const team = await Team.findById(query.team).select("leaders members").lean();
      if (team) {
        const memberIds = [
          ...((team.leaders as unknown[]) ?? []),
          ...((team.members as unknown[]) ?? []),
        ].map((id) => String(id));
        filter._id = { $in: memberIds };
      } else {
        // Unknown team — return empty result
        filter._id = { $in: [] };
      }
    }

    const sortField = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder === "asc" ? 1 : -1;

    const [users, total] = await Promise.all([
      User.find(filter)
        .populate("role", "roleName")
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return { users, pagination: buildPagination(total, page, limit) };
  }

  async getUserById(id: string) {
    const user = await User.findById(id).populate("role");
    if (!user) {
      throw Object.assign(new Error("User not found"), { statusCode: 404 });
    }
    return user;
  }

  async updateUser(id: string, input: UpdateUserInput) {
    const user = await User.findById(id);
    if (!user) {
      throw Object.assign(new Error("User not found"), { statusCode: 404 });
    }

    if (input.email && input.email !== user.email) {
      const existing = await User.findOne({ email: input.email.toLowerCase(), _id: { $ne: id } });
      if (existing) {
        throw Object.assign(new Error("Email already in use"), { statusCode: 409 });
      }
    }

    if (input.role) {
      const role = await Role.findById(input.role);
      if (!role) {
        throw Object.assign(new Error("Role not found"), { statusCode: 404 });
      }
    }

    // Handle password update separately to trigger the pre-save hook
    if (input.password) {
      user.password = input.password;
    }

    Object.assign(user, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.email !== undefined && { email: input.email.toLowerCase() }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.designation !== undefined && { designation: input.designation }),
      ...(input.status !== undefined && { status: input.status }),
    });

    await user.save();
    return User.findById(id).populate("role");
  }

  async deleteUser(id: string, requestingUserId: string) {
    if (id === requestingUserId) {
      throw Object.assign(new Error("You cannot delete your own account"), { statusCode: 400 });
    }

    const user = await User.findById(id).populate("role");
    if (!user) {
      throw Object.assign(new Error("User not found"), { statusCode: 404 });
    }

    const role = user.role as { isSystemRole?: boolean; roleName?: string };
    if (role?.isSystemRole && role?.roleName === "Super Admin") {
      throw Object.assign(new Error("Super Admin user cannot be deleted"), { statusCode: 403 });
    }

    await User.findByIdAndDelete(id);
    return { message: "User deleted successfully" };
  }

  async impersonateUser(requesterId: string, targetId: string, requesterRole: IRole) {
    if (requesterId === targetId) {
      throw Object.assign(new Error("Cannot impersonate yourself"), { statusCode: 400 });
    }

    const isSuperAdmin = requesterRole.isSystemRole && requesterRole.roleName === "Super Admin";

    if (!isSuperAdmin) {
      // Non-super-admin: target must share a team with the requester
      const sharedTeams = await Team.find({
        $or: [{ leaders: requesterId }, { members: requesterId }],
      }).lean();

      const targetInTeam = sharedTeams.some((team) =>
        [...(team.leaders as unknown[]), ...(team.members as unknown[])].some(
          (m) => String(m) === targetId
        )
      );

      if (!targetInTeam) {
        throw Object.assign(
          new Error("You can only impersonate users within your team"),
          { statusCode: 403 }
        );
      }
    }

    const target = await User.findById(targetId).populate("role").lean();
    if (!target) {
      throw Object.assign(new Error("User not found"), { statusCode: 404 });
    }
    if (target.status === "inactive") {
      throw Object.assign(new Error("Cannot impersonate an inactive user"), { statusCode: 400 });
    }

    // Never allow impersonating a Super Admin (unless you are one)
    const targetRole = target.role as IRole;
    if (!isSuperAdmin && targetRole.isSystemRole && targetRole.roleName === "Super Admin") {
      throw Object.assign(new Error("Cannot impersonate a Super Admin"), { statusCode: 403 });
    }

    const token = signAccessToken(
      {
        userId: String(target._id),
        email: target.email,
        roleId: String(targetRole._id),
        impersonatedBy: requesterId,
      },
      { expiresIn: "2h" }
    );

    return { token, user: target };
  }
}
