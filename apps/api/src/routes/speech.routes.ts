/** /api/speech: dictation. Read aloud is GET /api/messages/:id/speech. */
import express, { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";
import { MAX_AUDIO_BYTES } from "../services/speech.service";

export const router = Router();
/** Dictation: POST the raw audio (webm, ogg, mp3, m4a, wav; at most 25 MB) with its Content-Type. `{ text }`. `?language=en`. */
router.post("/transcribe", authenticate, express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), ctrl.transcribe);
