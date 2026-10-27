/** Models, meta, preferences, usage, memories, projects, images, shares and speech. Thin controllers. */
import type { Request, Response } from "express";
import { ASPECT_RATIOS, type AspectRatio } from "@open-chat/types";
import { z } from "zod";
import { notFound } from "../core/errors";
import { id, idParam, parse } from "../core/validate";
import { actorOf } from "../middleware/http";
import * as images from "../services/image.service";
import * as memory from "../services/memory.service";
import { appMeta } from "../services/meta.service";
import { catalog } from "../services/models.service";
import * as prefs from "../services/preferences.service";
import * as projects from "../services/project.service";
import { usageOf } from "../services/quota.service";
import * as shares from "../services/share.service";
import * as speech from "../services/speech.service";

const aspect = z.enum(ASPECT_RATIOS as unknown as [AspectRatio, ...AspectRatio[]]);

export async function meta(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json(await appMeta());
}

export async function models(req: Request, res: Response) {
  actorOf(req);
  res.json(await catalog());
}

export async function usage(req: Request, res: Response) {
  res.json(await usageOf(actorOf(req).id));
}

export async function getPreferences(req: Request, res: Response) {
  res.json(await prefs.preferencesOf(actorOf(req).id));
}

export async function updatePreferences(req: Request, res: Response) {
  const body = parse(
    z
      .object({
        aboutMe: z.string().max(1500),
        customInstructions: z.string().max(1500),
        answerStyle: z.enum(["CONCISE", "BALANCED", "DETAILED"]),
        memoryEnabled: z.boolean(),
        webSearchDefault: z.boolean(),
        defaultModelId: id().nullable(),
        voice: z.string().max(40),
      })
      .partial()
      .strict(),
    req.body,
  );
  res.json(await prefs.updatePreferences(actorOf(req), body));
}

// ─── Memories ───────────────────────────────────────────────────────────────

const memoryBody = z.object({ content: z.string().trim().min(1).max(500) }).strict();

export async function listMemories(req: Request, res: Response) {
  res.json(await memory.listMemories(actorOf(req)));
}
export async function addMemory(req: Request, res: Response) {
  res.status(201).json(await memory.addMemory(actorOf(req), parse(memoryBody, req.body).content));
}
export async function updateMemory(req: Request, res: Response) {
  res.json(await memory.updateMemory(actorOf(req), parse(idParam, req.params).id, parse(memoryBody, req.body).content));
}
export async function deleteMemory(req: Request, res: Response) {
  await memory.deleteMemory(actorOf(req), parse(idParam, req.params).id);
  res.status(204).end();
}
export async function clearMemories(req: Request, res: Response) {
  await memory.clearMemories(actorOf(req));
  res.status(204).end();
}

// ─── Projects ───────────────────────────────────────────────────────────────

const projectBody = z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().max(4000) });

export async function listProjects(req: Request, res: Response) {
  res.json(await projects.listProjects(actorOf(req)));
}
export async function getProject(req: Request, res: Response) {
  res.json(await projects.getProject(actorOf(req), parse(idParam, req.params).id));
}
export async function createProject(req: Request, res: Response) {
  res.status(201).json(await projects.createProject(actorOf(req), parse(projectBody.partial({ instructions: true }).strict(), req.body)));
}
export async function updateProject(req: Request, res: Response) {
  res.json(await projects.updateProject(actorOf(req), parse(idParam, req.params).id, parse(projectBody.partial().strict(), req.body)));
}
export async function deleteProject(req: Request, res: Response) {
  await projects.deleteProject(actorOf(req), parse(idParam, req.params).id);
  res.status(204).end();
}
export async function addProjectFile(req: Request, res: Response) {
  res.json(await projects.addProjectFile(actorOf(req), parse(idParam, req.params).id, parse(z.object({ fileId: id() }).strict(), req.body).fileId));
}
export async function removeProjectFile(req: Request, res: Response) {
  const p = parse(z.object({ id: id(), fileId: id() }), req.params);
  res.json(await projects.removeProjectFile(actorOf(req), p.id, p.fileId));
}

// ─── Images ─────────────────────────────────────────────────────────────────

export async function listImages(req: Request, res: Response) {
  const q = parse(z.object({ cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(60).optional() }), req.query);
  res.json(await images.listImages(actorOf(req), q.cursor, q.limit));
}
export async function createImage(req: Request, res: Response) {
  const body = parse(z.object({ prompt: z.string().trim().min(1).max(4000), aspectRatio: aspect.default("1:1"), sourceImageId: id().optional() }).strict(), req.body);
  res.status(201).json(await images.createImage(actorOf(req), body));
}
export async function deleteImage(req: Request, res: Response) {
  await images.deleteImage(actorOf(req), parse(idParam, req.params).id);
  res.status(204).end();
}

// ─── Shares ─────────────────────────────────────────────────────────────────

/** A malformed share id is just a link that does not exist. */
function shareId(req: Request): string {
  const id = String(req.params.id ?? "");
  if (!shares.SHARE_ID.test(id)) throw notFound("This link does not exist or was removed", "SHARE_NOT_FOUND");
  return id;
}

export async function createShare(req: Request, res: Response) {
  const body = parse(z.object({ conversationId: id(), expiresInDays: z.number().int().min(1).max(365).nullable().optional() }).strict(), req.body);
  res.status(201).json(await shares.createShare(actorOf(req), body.conversationId, body));
}
export async function listShares(req: Request, res: Response) {
  res.json(await shares.listShares(actorOf(req)));
}
export async function revokeShare(req: Request, res: Response) {
  await shares.revokeShare(actorOf(req), shareId(req));
  res.status(204).end();
}
export async function readShared(req: Request, res: Response) {
  const id = shareId(req);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.json(await shares.readShared(id));
}
export async function sharedImage(req: Request, res: Response) {
  const p = z.object({ id: z.string().regex(shares.SHARE_ID), fileId: id() }).safeParse(req.params);
  if (!p.success) throw notFound();
  res.setHeader("Cache-Control", "private, no-store");
  res.redirect(302, await shares.sharedImageUrl(p.data.id, p.data.fileId));
}

// ─── Speech ─────────────────────────────────────────────────────────────────

/** Body: the raw audio bytes, with their Content-Type. Optional ?language=en. */
export async function transcribe(req: Request, res: Response) {
  const q = parse(z.object({ language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional() }), req.query);
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.json(await speech.dictate(actorOf(req), { data, mimeType: req.get("content-type") ?? "" }, q.language));
}

export async function readAloud(req: Request, res: Response) {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  await speech.readAloud(actorOf(req), parse(idParam, req.params).id, res, controller.signal);
}
