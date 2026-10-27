/** /api/models: the model picker. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** The model picker (`ModelCatalog`): enabled chat models with their capabilities, and whether image generation is on. */
router.get("/", authenticate, ctrl.models);
