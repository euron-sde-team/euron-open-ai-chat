/** /api/memories: what the assistant remembers about you. You can see, edit and delete every memory. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** Everything the assistant remembers about you (`Memory[]`), newest first. */
router.get("/", authenticate, ctrl.listMemories);
/** Add a memory yourself `{ content }`. 201. 409 MEMORY_LIMIT. */
router.post("/", authenticate, ctrl.addMemory);
/** Forget everything. 204. */
router.delete("/", authenticate, ctrl.clearMemories);
router.patch("/:id", authenticate, ctrl.updateMemory);
router.delete("/:id", authenticate, ctrl.deleteMemory);
