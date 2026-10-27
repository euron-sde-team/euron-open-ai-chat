/** /api/turns: following and stopping an answer while the server writes it. */
import { Router } from "express";
import * as ctrl from "../controllers/chat.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/**
 * The turn's events as Server-Sent Events, from `?after=<seq>` (or the Last-Event-ID header). Ends after `done`. Works
 * for a finished turn too (replays the final message). See docs/api/streaming.md.
 */
router.get("/:id/events", authenticate, ctrl.events);
/** Stop the answer: the partial text is kept with status CANCELLED. 204. */
router.post("/:id/cancel", authenticate, ctrl.cancel);
