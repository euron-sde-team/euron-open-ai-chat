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
/** Native apps: register this install for push, `{ platform, token, appVersion? }` (`PushDevice`). The same token moves to whoever registers it last. */
router.put("/devices", authenticate, ctrl.registerDevice);
/** Stop push to this install. 204 (also when the token is unknown or someone else's). */
router.delete("/devices/:token", authenticate, ctrl.removeDevice);
