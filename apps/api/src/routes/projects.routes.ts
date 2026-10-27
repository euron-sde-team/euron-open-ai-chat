/** /api/projects: chats grouped under shared instructions and knowledge files. */
import { Router } from "express";
import * as ctrl from "../controllers/me.controller";
import { authenticate } from "../middleware/auth";

export const router = Router();
/** Your projects (`Project[]`). */
router.get("/", authenticate, ctrl.listProjects);
/** Create `{ name, instructions? }`. 201 `ProjectDetail`. */
router.post("/", authenticate, ctrl.createProject);
router.get("/:id", authenticate, ctrl.getProject);
router.patch("/:id", authenticate, ctrl.updateProject);
/** Delete a project: its chats stay (outside any project), its knowledge files are removed. 204. */
router.delete("/:id", authenticate, ctrl.deleteProject);
/** Add a knowledge file `{ fileId }` (uploaded with purpose PROJECT). `ProjectDetail`. */
router.post("/:id/files", authenticate, ctrl.addProjectFile);
router.delete("/:id/files/:fileId", authenticate, ctrl.removeProjectFile);
