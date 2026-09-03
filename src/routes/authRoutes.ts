import { Router } from "express";
import { login, refreshToken, getProfile, changePassword, getLoginHistory, getOnlineUsers } from "../controllers/authController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

// Public routes
router.post("/login", login);
router.post("/refresh-token", refreshToken);

// Protected routes
router.get("/profile",        authenticate, getProfile);
router.put("/change-password",authenticate, changePassword);
router.get("/login-history",  authenticate, getLoginHistory);
router.get("/online-users",   authenticate, getOnlineUsers);

export default router;
