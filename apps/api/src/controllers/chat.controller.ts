/** /api/chats, /api/messages and /api/turns. Thin: parse, call the service, respond. */
import type { Request, Response } from "express";
import { ASPECT_RATIOS, type AspectRatio } from "@open-chat/types";
import { z } from "zod";
import { captureError } from "../core/logger";
import { id, idParam, parse } from "../core/validate";
import { actorOf } from "../middleware/http";
import { openSse, resumeAfter } from "../middleware/sse";
import * as chat from "../services/chat/chat.service";
import { armTurnNotification } from "../services/push.service";

const aspect = z.enum(ASPECT_RATIOS as unknown as [AspectRatio, ...AspectRatio[]]);

const listQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().trim().max(200).optional(),
  projectId: id().optional(),
  archived: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  pinned: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

const sendBody = z
  .object({
    content: z.string().max(chat.MAX_MESSAGE_CHARS).default(""),
    parentId: id().nullable().optional(),
    modelId: id().optional(),
    fileIds: z.array(id()).max(chat.MAX_FILES_PER_MESSAGE).optional(),
    webSearch: z.boolean().optional(),
    mode: z.enum(["chat", "image"]).optional(),
    aspectRatio: aspect.optional(),
    projectId: id().nullable().optional(),
  })
  .strict();

const conversationParam = z.object({ id: z.union([id(), z.literal("new")]) });

export async function list(req: Request, res: Response) {
  res.json(await chat.listConversations(actorOf(req), parse(listQuery, req.query)));
}

export async function create(req: Request, res: Response) {
  const body = parse(z.object({ title: z.string().trim().max(120).optional(), projectId: id().nullable().optional() }).strict(), req.body);
  res.status(201).json(await chat.createConversation(actorOf(req), body));
}

export async function get(req: Request, res: Response) {
  res.json(await chat.getConversation(actorOf(req), parse(idParam, req.params).id));
}

export async function update(req: Request, res: Response) {
  const body = parse(z.object({ title: z.string().trim().min(1).max(120), pinned: z.boolean(), archived: z.boolean(), projectId: id().nullable() }).partial().strict(), req.body);
  res.json(await chat.updateConversation(actorOf(req), parse(idParam, req.params).id, body));
}

export async function remove(req: Request, res: Response) {
  await chat.deleteConversation(actorOf(req), parse(idParam, req.params).id);
  res.status(204).end();
}

export async function removeAll(req: Request, res: Response) {
  res.json({ deleted: await chat.deleteAllConversations(actorOf(req)) });
}

/** Send, then either stream the turn on this response (Accept: text/event-stream) or answer 202 with the turn id. */
export async function send(req: Request, res: Response) {
  const actor = actorOf(req);
  const { id: conversationId } = parse(conversationParam, req.params);
  const started = await chat.sendMessage(actor, conversationId, parse(sendBody, req.body));
  await respondWithTurn(req, res, actor, started);
}

export async function regenerate(req: Request, res: Response) {
  const actor = actorOf(req);
  const body = parse(z.object({ modelId: id().optional(), webSearch: z.boolean().optional() }).strict(), req.body);
  const started = await chat.regenerate(actor, parse(idParam, req.params).id, body);
  await respondWithTurn(req, res, actor, started);
}

async function respondWithTurn(req: Request, res: Response, actor: ReturnType<typeof actorOf>, started: Awaited<ReturnType<typeof chat.sendMessage>>) {
  if (!(req.get("accept") ?? "").includes("text/event-stream")) {
    res.status(202).json(started);
    return;
  }
  const sse = openSse(req, res);
  try {
    for await (const ev of chat.turnEvents(actor, started.turnId, 0, sse.signal)) sse.send(ev);
  } catch (err) {
    captureError(err, { where: "sse.send", turnId: started.turnId });
  } finally {
    sse.end();
  }
}

export async function setLeaf(req: Request, res: Response) {
  const body = parse(z.object({ messageId: id() }).strict(), req.body);
  res.json(await chat.setLeaf(actorOf(req), parse(idParam, req.params).id, body.messageId));
}

export async function feedback(req: Request, res: Response) {
  const body = parse(z.object({ value: z.union([z.literal(1), z.literal(-1), z.null()]) }).strict(), req.body);
  res.json(await chat.setFeedback(actorOf(req), parse(idParam, req.params).id, body.value));
}

export async function events(req: Request, res: Response) {
  const actor = actorOf(req);
  const { id: turnId } = parse(idParam, req.params);
  // Ownership is checked before the stream opens, so a stranger's id is a plain 404.
  await chat.checkTurn(actor, turnId);
  const sse = openSse(req, res);
  try {
    for await (const ev of chat.turnEvents(actor, turnId, resumeAfter(req), sse.signal)) sse.send(ev);
  } catch (err) {
    captureError(err, { where: "sse.events", turnId });
  } finally {
    sse.end();
  }
}

export async function cancel(req: Request, res: Response) {
  await chat.cancelTurn(actorOf(req), parse(idParam, req.params).id);
  res.status(204).end();
}

export async function notify(req: Request, res: Response) {
  res.json(await armTurnNotification(actorOf(req), parse(idParam, req.params).id));
}
