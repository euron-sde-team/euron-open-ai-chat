/**
 * Push for the native apps: devices, the per-turn opt-in (POST /turns/:id/notify), the
 * notification that follows, and the cases where nothing may be sent.
 */
import type { IssuedNativeSession, PushDevice, TurnNotifyResult } from "@open-chat/types";
import request from "supertest";
import { afterEach, describe, expect, test } from "vitest";
import { db } from "../../src/db/kysely";
import { setPushProviderForTests } from "../../src/integrations/push";
import { redis } from "../../src/integrations/redis";
import { sendTurnReady } from "../../src/services/push.service";
import { app, as, chat, createUser, PASSWORD, send, stubsUrl, unique, waitFor, type TestUser } from "./harness";

interface FcmRecord {
  message: { token: string; notification: { title: string; body: string }; data: Record<string, string> };
}

async function fcmMessages(token: string): Promise<FcmRecord[]> {
  const res = await fetch(`${stubsUrl()}/fcm/messages?token=${encodeURIComponent(token)}`);
  return ((await res.json()) as { messages: FcmRecord[] }).messages;
}

async function register(user: TestUser, token = unique("tok"), platform: "IOS" | "ANDROID" = "IOS"): Promise<string> {
  await as(user).put("/api/me/devices").send({ platform, token, appVersion: "1.0.0" }).expect(200);
  return token;
}

async function messageStatus(id: string): Promise<string> {
  return (await db.selectFrom("messages").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
}

afterEach(() => setPushProviderForTests(null));

describe("devices", () => {
  test("register returns the device; the same token moves to whoever registers it last", async () => {
    const ada = await createUser();
    const bo = await createUser();
    const token = unique("tok");
    const d = (await as(ada).put("/api/me/devices").send({ platform: "ANDROID", token, appVersion: "1.2.0" }).expect(200)).body as PushDevice;
    expect(d).toMatchObject({ platform: "ANDROID", appVersion: "1.2.0" });
    expect(JSON.stringify(d)).not.toContain(token);
    await register(bo, token);
    const rows = await db.selectFrom("push_devices").select(["user_id", "platform"]).where("token", "=", token).execute();
    expect(rows).toEqual([{ user_id: bo.id, platform: "IOS" }]);
  });

  test("bodies are strict; signed-out callers are refused", async () => {
    const ada = await createUser();
    await as(ada).put("/api/me/devices").send({ platform: "WINDOWS", token: "x" }).expect(400);
    await as(ada).put("/api/me/devices").send({ platform: "IOS", token: "x", extra: 1 }).expect(400);
    await request(app).put("/api/me/devices").send({ platform: "IOS", token: "x" }).expect(401);
  });

  test("delete removes only your own token, and answers 204 either way", async () => {
    const ada = await createUser();
    const bo = await createUser();
    const mine = await register(ada);
    const theirs = await register(bo);
    await as(ada).delete(`/api/me/devices/${encodeURIComponent(theirs)}`).expect(204);
    await as(ada).delete(`/api/me/devices/${encodeURIComponent(mine)}`).expect(204);
    expect(await db.selectFrom("push_devices").select("token").where("token", "in", [mine, theirs]).execute()).toEqual([{ token: theirs }]);
  });

  test("native sign-out with deviceToken removes that device; sign out everywhere removes them all", async () => {
    const ada = await createUser();
    const res = await request(app).post("/api/auth/login").set("X-Client", "native").send({ login: ada.email, password: PASSWORD }).expect(200);
    const session = res.body as IssuedNativeSession;
    const phone = await register(ada);
    const tablet = await register(ada, unique("tok"), "ANDROID");
    await request(app).post("/api/auth/logout").set("X-Client", "native").send({ refreshToken: session.refreshToken, deviceToken: phone }).expect(204);
    expect((await db.selectFrom("push_devices").select("token").where("user_id", "=", ada.id).execute()).map((r) => r.token)).toEqual([tablet]);
    await as(ada).post("/api/auth/logout-all").send({}).expect(204);
    expect(await db.selectFrom("push_devices").select("token").where("user_id", "=", ada.id).execute()).toEqual([]);
  });
});

describe("tell me when it is ready", () => {
  test("armed on a streaming answer: one push per device when it finishes, generic text, the chat in data", async () => {
    const ada = await createUser();
    const token = await register(ada);
    const started = await send(ada, "new", { content: "Write something slow about rivers" });
    const armed = (await as(ada).post(`/api/turns/${started.turnId}/notify`).send({}).expect(200)).body as TurnNotifyResult;
    expect(armed).toEqual({ state: "armed" });
    const [sent] = await waitFor(async () => {
      const m = await fcmMessages(token);
      return m.length ? m : null;
    });
    expect(sent!.message.notification).toEqual({ title: expect.any(String), body: "Your answer is ready." });
    expect(sent!.message.data).toEqual({ type: "turn", conversationId: started.conversationId, messageId: started.assistantMessageId });
    expect(JSON.stringify(sent)).not.toContain("rivers");
    expect(await redis().exists(`turn:${started.turnId}:notify`)).toBe(0);
  });

  test("a finished answer is not armed; without asking, nothing is sent", async () => {
    const ada = await createUser();
    const token = await register(ada);
    const { started } = await chat(ada, "A quick question");
    expect((await as(ada).post(`/api/turns/${started.turnId}/notify`).send({}).expect(200)).body).toEqual({ state: "finished" });
    expect(await redis().exists(`turn:${started.turnId}:notify`)).toBe(0);
    expect(await fcmMessages(token)).toEqual([]);
  });

  test("a cancelled answer sends nothing", async () => {
    const ada = await createUser();
    const token = await register(ada);
    const started = await send(ada, "new", { content: "Something slow to stop" });
    await as(ada).post(`/api/turns/${started.turnId}/notify`).send({}).expect(200);
    await as(ada).post(`/api/turns/${started.turnId}/cancel`).expect(204);
    await waitFor(async () => (await messageStatus(started.assistantMessageId)) === "CANCELLED");
    await new Promise((r) => setTimeout(r, 200));
    expect(await fcmMessages(token)).toEqual([]);
  });

  test("a failed answer says so", async () => {
    const ada = await createUser();
    const token = await register(ada);
    const { started } = await chat(ada, "Anything");
    // The job the turn queues when it ends in FAILED (a stub failure ends too fast to arm by racing it).
    await sendTurnReady({ userId: ada.id, conversationId: started.conversationId, messageId: started.assistantMessageId, ok: false });
    const [sent] = await fcmMessages(token);
    expect(sent!.message.notification.body).toMatch(/could not be finished/);
  });

  test("someone else's turn is 404; a server without push answers 409", async () => {
    const ada = await createUser();
    const bo = await createUser();
    const { started } = await chat(ada, "Mine");
    await as(bo).post(`/api/turns/${started.turnId}/notify`).send({}).expect(404);
    setPushProviderForTests(null);
    const { config } = await import("../../src/core/config");
    const before = config.PUSH_PROVIDER;
    (config as { PUSH_PROVIDER: string }).PUSH_PROVIDER = "none";
    try {
      const res = await as(ada).post(`/api/turns/${started.turnId}/notify`).send({}).expect(409);
      expect(res.body.code).toBe("PUSH_DISABLED");
    } finally {
      (config as { PUSH_PROVIDER: string }).PUSH_PROVIDER = before;
    }
  });

  test("a token FCM reports as dead is removed; others keep working", async () => {
    const ada = await createUser();
    const dead = await register(ada, unique("dead"));
    const live = await register(ada, unique("tok"), "ANDROID");
    const started = await send(ada, "new", { content: "Tell me something slow" });
    await as(ada).post(`/api/turns/${started.turnId}/notify`).send({}).expect(200);
    await waitFor(async () => (await fcmMessages(live)).length > 0);
    await waitFor(async () => !(await db.selectFrom("push_devices").select("id").where("token", "=", dead).executeTakeFirst()));
  });
});
