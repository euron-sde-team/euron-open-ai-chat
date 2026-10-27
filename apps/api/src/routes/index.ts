/**
 * Every router and where it is mounted. scripts/gen-openapi.ts reads this file, so keep
 * one `[prefix, router]` entry per line.
 */
import type { Express } from "express";
import { router as admin } from "./admin.routes";
import { router as auth } from "./auth.routes";
import { router as chats } from "./chats.routes";
import { router as files } from "./files.routes";
import { router as images } from "./images.routes";
import { router as me } from "./me.routes";
import { router as memories } from "./memories.routes";
import { router as messages } from "./messages.routes";
import { router as meta } from "./meta.routes";
import { router as models } from "./models.routes";
import { router as projects } from "./projects.routes";
import { router as shared } from "./shared.routes";
import { router as shares } from "./shares.routes";
import { router as speech } from "./speech.routes";
import { router as turns } from "./turns.routes";
import { router as users } from "./users.routes";

export const MOUNTS = [
  ["/api/auth", auth],
  ["/api/users", users],
  ["/api/meta", meta],
  ["/api/models", models],
  ["/api/me", me],
  ["/api/files", files],
  ["/api/chats", chats],
  ["/api/messages", messages],
  ["/api/turns", turns],
  ["/api/memories", memories],
  ["/api/projects", projects],
  ["/api/images", images],
  ["/api/shares", shares],
  ["/api/shared", shared],
  ["/api/speech", speech],
  ["/api/admin", admin],
] as const;

export function mountRoutes(app: Express): void {
  for (const [prefix, router] of MOUNTS) app.use(prefix, router);
}
