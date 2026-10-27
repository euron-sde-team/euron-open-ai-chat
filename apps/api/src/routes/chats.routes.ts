/**
 * /api/chats: conversations and sending messages. A send starts a turn on the server;
 * with `Accept: text/event-stream` the same response streams its events
 * (docs/api/streaming.md), otherwise it answers 202 `TurnStarted` and the client follows
 * GET /api/turns/:id/events.
 */
import { Router } from "express";
import * as ctrl from "../controllers/chat.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();

/** Your conversations (`Page<ConversationSummary>`), most recent first: `?cursor&limit&q&projectId&archived&pinned`. `q` matches titles and message text. */
router.get("/", authenticate, ctrl.list);
/** Start an empty conversation `{ title?, projectId? }`. 201 `ConversationSummary`. Most clients send to `new` instead. */
router.post("/", authenticate, ctrl.create);
/** Delete every one of your conversations. `{ deleted }`. */
router.delete("/", authenticate, ctrl.removeAll);
/** One conversation with the branch on screen (`ConversationDetail`); `activeTurnId` when an answer is still being written. */
router.get("/:id", authenticate, ctrl.get);
/** Rename (locks the title), pin, archive or move to a project: `{ title?, pinned?, archived?, projectId? }`. `ConversationSummary`. */
router.patch("/:id", authenticate, ctrl.update);
/** Delete a conversation (a running answer is cancelled). 204. */
router.delete("/:id", authenticate, ctrl.remove);
/**
 * Send a message (`SendMessageInput` + `projectId?` for a new chat). `:id` may be `new`. `parentId` edits an earlier
 * question as a new branch. 202 `TurnStarted`, or an event stream. 409 TURN_IN_PROGRESS; 400 MODEL_NO_VISION,
 * MESSAGE_TOO_LONG, FILE_NOT_FOUND; 503 MODEL_UNAVAILABLE; 429 RATE_LIMITED (30 sends a minute).
 */
router.post("/:id/messages", authenticate, ctrl.send);
/** Show another branch: `{ messageId }` (the leaf becomes its newest descendant). `ConversationDetail`. */
router.put("/:id/leaf", authenticate, ctrl.setLeaf);
