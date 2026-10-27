/** /api/files: direct-to-storage uploads, your files, and the local-storage stand-in for presigned URLs. */
import { Router } from "express";
import * as ctrl from "../controllers/file.controller";
import { authenticate } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

export const router = Router();

/**
 * Start an upload `{ purpose: AVATAR|ATTACHMENT|PROJECT, fileName, mimeType, sizeBytes }`. Validates type and size
 * (min of the kind limit and your tier's max_file_mb) and returns an `UploadTicket`: PUT the bytes to `uploadUrl` with
 * `headers`, then call complete. 413 FILE_TOO_LARGE; 400 FILE_TYPE_NOT_ALLOWED, FILE_EXTENSION_MISMATCH, FILE_PURPOSE_MISMATCH.
 */
router.post("/", authenticate, rateLimit("file-create", 60, 600), ctrl.create);
/** Your files (`ChatFile[]`), newest first; `?purpose=`. */
router.get("/", authenticate, ctrl.list);
/** Upload bytes to a signed local link (STORAGE=local only). */
router.put("/local/:token", ctrl.localPut);
/** Read a file through a signed local link (STORAGE=local only). */
router.get("/local/:token", ctrl.localGet);
/** One of your files (`ChatFile`): poll until `status` is READY (or REJECTED with `rejectedReason`). Other users' files are 404. */
router.get("/:id", authenticate, ctrl.get);
/**
 * Finish an upload: verifies the stored size and magic bytes, then queues processing (images re-encoded without EXIF,
 * documents read and indexed). Returns the `ChatFile` (PROCESSING, or READY). 400 UPLOAD_MISSING, FILE_SIZE_MISMATCH, FILE_TYPE_MISMATCH.
 */
router.post("/:id/complete", authenticate, ctrl.complete);
/** Delete a file. 409 FILE_IN_USE when it was sent in a message (delete the conversation instead). 204. */
router.delete("/:id", authenticate, ctrl.remove);
