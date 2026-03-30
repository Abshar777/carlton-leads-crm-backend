import { Server, type Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { env } from "./config/env.js";
import { verifyAccessToken } from "./utils/jwt.js";

let io: Server;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_URL,
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // ── JWT auth middleware ──────────────────────────────────────────────────────
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Authentication required"));
    try {
      const decoded = verifyAccessToken(token);
      socket.data.userId = decoded.userId;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  // ── Connection handler ───────────────────────────────────────────────────────
  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;

    // Each user automatically joins their own private room
    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`🟢 Socket connected: userId=${userId} socketId=${socket.id}`);
    }

    socket.on("disconnect", () => {
      console.log(`🔴 Socket disconnected: userId=${userId} socketId=${socket.id}`);
    });

    // Client joins a specific team room
    socket.on("join:team", (teamId: string) => {
      if (typeof teamId === "string" && teamId.length > 0) {
        socket.join(`team:${teamId}`);
        console.log(`📌 User ${userId} joined team room: ${teamId}`);
      }
    });

    socket.on("leave:team", (teamId: string) => {
      if (typeof teamId === "string") {
        socket.leave(`team:${teamId}`);
      }
    });
  });

  console.log("🔌 Socket.IO initialized");
  return io;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getIO(): Server {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
}

/**
 * Emit a real-time update event to all sockets in a team's room.
 */
export function emitTeamUpdate(teamId: string, item: object): void {
  if (!io) return;
  io.to(`team:${teamId}`).emit("team:update", { teamId, item });
}

/**
 * Emit a notification to a specific user's private room.
 * type: "lead_assigned" | "team_message" | "status_changed" | "note_added"
 */
export function emitToUser(
  userId: string,
  event: string,
  payload: object
): void {
  if (!io) return;
  const room = `user:${userId}`;
  const sockets = io.sockets.adapter.rooms.get(room);
  console.log(`📤 emitToUser → room=${room} sockets=${sockets?.size ?? 0} event=${event}`);
  io.to(room).emit(event, payload);
}
