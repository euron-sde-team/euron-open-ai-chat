/** /api/me: your usage and preferences. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** Today's use against your allowance (`Usage`). Resets at midnight UTC. */
router.get("/usage", authenticate, ctrl.usage);
/** Your `Preferences`. */
router.get("/preferences", authenticate, ctrl.getPreferences);
/** Change preferences: any of `{ aboutMe, customInstructions, answerStyle, memoryEnabled, webSearchDefault, defaultModelId, voice }`. */
router.patch("/preferences", authenticate, ctrl.updatePreferences);
