/** /api/messages: actions on one message. */
import { Router } from "express";
import * as ctrl from "../controllers/chat.controller";
import * as me from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** A new answer to the same question, as a sibling: `{ modelId?, webSearch? }`. 202 `TurnStarted` or an event stream. */
router.post("/:id/regenerate", authenticate, ctrl.regenerate);
/** Thumbs up or down on an answer: `{ value: 1 | -1 | null }`. `Message`. */
router.put("/:id/feedback", authenticate, ctrl.feedback);
/** Read an answer aloud: streams `audio/mpeg`. 503 MODEL_UNAVAILABLE when no SPEECH model is configured. */
router.get("/:id/speech", authenticate, me.readAloud);
