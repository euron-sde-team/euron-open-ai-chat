/**
 * Push notifications for the native apps.
 *
 * Devices (PUT / DELETE /api/me/devices): the app registers its FCM token after sign-in
 * and whenever the token changes. The same token registered by another account moves to
 * that account, since a device belongs to whoever is signed in on it. Native sign-out
 * with `deviceToken` removes it; ending every session of an account removes them all
 * (session.repository.ts revokeAllForUser).
 *
 * Nothing is pushed by default. An app that goes to the background while an answer is
 * still being written asks for it (POST /api/turns/:id/notify): that sets
 * `turn:<id>:notify` in Redis. When the turn ends (turns.ts) `afterTurn` takes the key
 * and, if it was there, queues `push.turn-ready`. The web app never asks, so it never
 * causes a push, and an answer someone is watching never does either.
 *
 * A notification says only that the answer is ready, unless PUSH_PREVIEW is on: its
 * text passes through Google (and Apple) and shows on a locked screen.
 */
import type { PushDevice, PushPlatform, TurnNotifyResult } from "@open-chat/types";
import { config } from "../core/config";
import type { Actor } from "../core/context";
import { conflict, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { captureError, logger } from "../core/logger";
import { redis } from "../integrations/redis";
import { pushProvider } from "../integrations/push";
import { enqueue } from "../jobs/registry";
import { chatRepo } from "../repositories/chat.repository";
import { pushDeviceRepo, type PushDeviceRow } from "../repositories/push-device.repository";
import { appName } from "./settings.service";

/** How long an armed notification waits for its turn (a turn never runs this long). */
const NOTIFY_TTL_SECONDS = 3600;
const PREVIEW_CHARS = 120;
const notifyKey = (turnId: string) => `turn:${turnId}:notify`;

function present(r: PushDeviceRow): PushDevice {
  return { id: r.id, platform: r.platform as PushPlatform, appVersion: r.app_version, createdAt: r.created_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString() };
}

export async function registerDevice(actor: Actor, input: { platform: PushPlatform; token: string; appVersion?: string | null }): Promise<PushDevice> {
  const row = await pushDeviceRepo.upsert({ id: newId(), user_id: actor.id, platform: input.platform, token: input.token, app_version: input.appVersion ?? null });
  return present(row);
}

/** DELETE /api/me/devices/:token. Someone else's token is left alone (still 204: nothing to reveal). */
export async function removeDevice(userId: string, token: string): Promise<void> {
  await pushDeviceRepo.deleteOwn(userId, token);
}

/** POST /api/turns/:id/notify. */
export async function armTurnNotification(actor: Actor, turnId: string): Promise<TurnNotifyResult> {
  if (!pushProvider()) throw conflict("This server does not send push notifications", "PUSH_DISABLED");
  const m = await chatRepo.findOwnedMessage(actor.id, turnId);
  if (!m || m.role !== "ASSISTANT") throw notFound("Turn not found", "TURN_NOT_FOUND");
  if (m.status !== "STREAMING") return { state: "finished" };
  await redis().set(notifyKey(turnId), actor.id, "EX", NOTIFY_TTL_SECONDS);
  // The turn may have ended between the read above and the SET: take the key back so it
  // does not wait an hour for nothing. If afterTurn took it first, the push is on its way.
  const now = await chatRepo.findMessage(turnId);
  if (now && now.status !== "STREAMING") {
    await redis().del(notifyKey(turnId));
    return { state: "finished" };
  }
  return { state: "armed" };
}

/** Called by turns.ts once a turn has written `done`. One Redis round trip when nobody asked. */
export async function afterTurn(turnId: string, conversationId: string, status: "COMPLETE" | "FAILED" | "CANCELLED"): Promise<void> {
  try {
    const userId = await redis().getdel(notifyKey(turnId));
    if (!userId || status === "CANCELLED") return;
    await enqueue("push.turn-ready", { userId, conversationId, messageId: turnId, ok: status === "COMPLETE" });
  } catch (err) {
    captureError(err, { where: "push.afterTurn" });
  }
}

/** The push.turn-ready job: one message per device of the user; dead tokens are removed. */
export async function sendTurnReady(input: { userId: string; conversationId: string; messageId: string; ok: boolean }): Promise<void> {
  const provider = pushProvider();
  if (!provider) return;
  const devices = await pushDeviceRepo.listForUser(input.userId);
  if (!devices.length) return;
  let title = await appName();
  let body = input.ok ? "Your answer is ready." : "Your answer could not be finished. Open the chat to try again.";
  if (config.PUSH_PREVIEW) {
    const [convo, message] = await Promise.all([chatRepo.findConversationById(input.conversationId), chatRepo.findMessage(input.messageId)]);
    if (convo?.title) title = convo.title;
    const text = message?.content.replace(/\s+/g, " ").trim();
    if (input.ok && text) body = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  }
  const dead: string[] = [];
  for (const d of devices) {
    const result = await provider.send({ token: d.token, platform: d.platform as PushPlatform, title, body, data: { type: "turn", conversationId: input.conversationId, messageId: input.messageId } });
    if (!result.ok) {
      if (result.dead) dead.push(d.token);
      else logger.warn({ provider: provider.name, deviceId: d.id, error: result.error }, "push not delivered");
    }
  }
  await pushDeviceRepo.deleteTokens(dead);
}
