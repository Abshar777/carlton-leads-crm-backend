import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { logTrap, fakeDownload, listTrapEvents, unreadCount } from "../controllers/trapController.js";

const router = Router();

router.use(authenticate);

// Static routes before parameterized
router.get("/fake-download",  fakeDownload);
router.get("/unread-count",   unreadCount);
router.get("/",               listTrapEvents);
router.post("/log",           logTrap);

export default router;
