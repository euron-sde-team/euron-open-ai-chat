/** /api/images: the image studio and your gallery. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** Your generated images (`Page<GeneratedImage>`), newest first. */
router.get("/", authenticate, ctrl.listImages);
/** Generate (or edit, with `sourceImageId`) outside a chat: `{ prompt, aspectRatio?, sourceImageId? }`. 201. 429 QUOTA_EXCEEDED. */
router.post("/", authenticate, ctrl.createImage);
/** Remove from the gallery (an image shown in a chat stays there). 204. */
router.delete("/:id", authenticate, ctrl.deleteImage);
