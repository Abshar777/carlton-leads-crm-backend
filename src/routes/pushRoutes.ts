import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import {
  getVapidPublicKey,
  subscribePush,
  unsubscribePush,
} from "../controllers/pushController.js";

const router = Router();

router.use(authenticate);

router.get("/vapid-public-key", getVapidPublicKey);
router.post("/subscribe",       subscribePush);
router.delete("/unsubscribe",   unsubscribePush);

export default router;
