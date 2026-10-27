/** /api/shares: public links to a frozen copy of a chat. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** Freeze the branch on screen into a public link: `{ conversationId, expiresInDays? }`. 201 `Share`. */
router.post("/", authenticate, ctrl.createShare);
router.get("/", authenticate, ctrl.listShares);
/** Revoke a link: it stops working at once. 204. */
router.delete("/:id", authenticate, ctrl.revokeShare);
