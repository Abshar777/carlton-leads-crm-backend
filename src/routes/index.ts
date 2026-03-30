import { Router } from "express";
import authRoutes from "./authRoutes.js";
import userRoutes from "./userRoutes.js";
import roleRoutes from "./roleRoutes.js";
import leadRoutes from "./leadRoutes.js";
import userLeadRoutes from "./userLeadRoutes.js";
import teamRoutes from "./teamRoutes.js";
import courseRoutes from "./courseRoutes.js";
import sheetsRoutes from "./sheetsRoutes.js";
import reportRoutes from "./reportRoutes.js";
import pushRoutes from "./pushRoutes.js";
import aiRoutes from "./aiRoutes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/users", userLeadRoutes);
router.use("/roles", roleRoutes);
router.use("/leads", leadRoutes);
router.use("/teams", teamRoutes);
router.use("/courses", courseRoutes);
router.use("/sheets",  sheetsRoutes);
router.use("/reports", reportRoutes);
router.use("/push",    pushRoutes);
router.use("/ai",      aiRoutes);

// Health check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
