/** /api/shared: the public side of a shared link. No account needed. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { rateLimit } from "../middleware/rate-limit";

export const router = Router();
/** A shared conversation (`SharedConversation`): the frozen snapshot. 404 SHARE_NOT_FOUND when revoked, expired or unknown. */
router.get("/:id", rateLimit("shared-read", 120, 60, "ip"), ctrl.readShared);
/** One image of a shared conversation: a 302 to a short-lived signed URL, only for images frozen into the snapshot. */
router.get("/:id/images/:fileId", rateLimit("shared-image", 600, 60, "ip"), ctrl.sharedImage);
