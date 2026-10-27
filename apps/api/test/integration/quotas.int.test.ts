/**
 * Daily allowances: tier limits, per-user overrides, a turn refused when the day's tokens
 * are used up, atomic image reservation under parallel requests, usage_daily holding
 * counts only, and the per-user send rate limit.
 */
import type { Usage } from "@open-chat/types";
import { describe, expect, test } from "vitest";
import { newId } from "../../src/core/ids";
import { db } from "../../src/db/kysely";
import { ERROR_MESSAGES } from "../../src/services/chat/turns";
import { as, chat, createUser, eventsOf, stubModels, type TestUser } from "./harness";

async function usage(user: TestUser): Promise<Usage> {
  return (await as(user).get("/api/me/usage").expect(200)).body as Usage;
}

async function override(user: TestUser, values: { daily_tokens?: number | null; daily_images?: number | null }) {
  await db.insertInto("user_quota_overrides").values({ user_id: user.id, daily_tokens: values.daily_tokens ?? null, daily_images: values.daily_images ?? null }).execute();
}

describe("usage and limits", () => {
  test("a new user is on the default tier; a turn moves today's weighted tokens by exactly what the usage event said", async () => {
    const ada = await createUser();
    const before = await usage(ada);
    expect(before).toMatchObject({ day: new Date().toISOString().slice(0, 10), tokens: { used: 0, limit: 200000 }, images: { used: 0, limit: 20 }, maxFileMb: 25 });
    expect(new Date(before.resetsAt).toISOString()).toBe(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const { events } = await chat(ada, "Count my tokens");
    const ev = eventsOf(events, "usage")[0]!;
    expect((await usage(ada)).tokens.used).toBe(ev.weightedTokens);
  });

  test("a tier sets the limits; an override wins field by field; a null override field falls back to the tier", async () => {
    const ada = await createUser();
    const tierId = newId();
    await db.insertInto("quota_tiers").values({ id: tierId, name: `Research ${tierId}`, daily_tokens: 5000, daily_images: 3, max_file_mb: 10 }).execute();
    await db.updateTable("users").set({ quota_tier_id: tierId }).where("id", "=", ada.id).execute();
    expect(await usage(ada)).toMatchObject({ tokens: { limit: 5000 }, images: { limit: 3 }, maxFileMb: 10 });
    await override(ada, { daily_tokens: 9, daily_images: null });
    expect(await usage(ada)).toMatchObject({ tokens: { limit: 9 }, images: { limit: 3 } });
  });

  test("a model's weight multiplies its tokens", async () => {
    const ada = await createUser();
    const { lite } = await stubModels();
    const { events } = await chat(ada, "Weigh this answer", { modelId: lite });
    const ev = eventsOf(events, "usage")[0]!;
    expect(ev.weightedTokens).toBe(Math.ceil((ev.inputTokens + ev.outputTokens) * 0.25));
  });
});

describe("running out", () => {
  test("no tokens left: the turn fails with QUOTA_EXCEEDED and the answer is FAILED", async () => {
    const ada = await createUser();
    await override(ada, { daily_tokens: 0 });
    const { started, events } = await chat(ada, "Am I over");
    expect(eventsOf(events, "error")).toEqual([{ seq: expect.any(Number), type: "error", code: "QUOTA_EXCEEDED", message: ERROR_MESSAGES.QUOTA_EXCEEDED }]);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "FAILED" });
    const row = await db.selectFrom("messages").select(["status", "error_code"]).where("id", "=", started.turnId).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "FAILED", error_code: "QUOTA_EXCEEDED" });
    // No model call was made for it, so nothing was charged.
    expect((await usage(ada)).tokens.used).toBe(0);
  });

  test("a turn may start under the limit and finish over it; the next one is refused", async () => {
    const ada = await createUser();
    await override(ada, { daily_tokens: 10 });
    const first = await chat(ada, "First of the day");
    expect(first.events.at(-1)).toMatchObject({ type: "done", status: "COMPLETE" });
    expect((await usage(ada)).tokens.used).toBeGreaterThan(10);
    const second = await chat(ada, "Second of the day", { conversationId: first.started.conversationId });
    expect(eventsOf(second.events, "error")[0]!.code).toBe("QUOTA_EXCEEDED");
  });

  test("image reservation is atomic: of 6 parallel requests with 2 images left, exactly 2 succeed", async () => {
    const ada = await createUser();
    await override(ada, { daily_images: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => as(ada).post("/api/images").send({ prompt: `A tiny boat number ${i}` })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 429, 429, 429, 429]);
    for (const r of results.filter((x) => x.status === 429)) expect(r.body.code).toBe("QUOTA_EXCEEDED");
    expect((await usage(ada)).images.used).toBe(2);
    expect(await db.selectFrom("images").select("id").where("user_id", "=", ada.id).execute()).toHaveLength(2);
  });

  test("a failed generation gives the image back", async () => {
    const ada = await createUser();
    await override(ada, { daily_images: 1 });
    // The stub image model refuses prompts carrying STUB_FLAG; moderation catches it first here.
    const refused = await as(ada).post("/api/images").send({ prompt: "STUB_FLAG picture" }).expect(400);
    expect(refused.body.code).toBe("CONTENT_BLOCKED");
    expect((await usage(ada)).images.used).toBe(0);
    await as(ada).post("/api/images").send({ prompt: "A calm lake" }).expect(201);
  });
});

describe("what is recorded", () => {
  test("usage_daily holds counts only: no text column for prompts or answers", async () => {
    const cols = await db
      .selectFrom("information_schema.columns" as any)
      .select(["column_name", "data_type"] as any)
      .where("table_name" as any, "=", "usage_daily")
      .execute();
    const byName = Object.fromEntries((cols as { column_name: string; data_type: string }[]).map((c) => [c.column_name, c.data_type]));
    expect(Object.keys(byName).sort()).toEqual(["day", "images", "input_tokens", "messages", "model_id", "output_tokens", "tool_calls", "user_id", "weighted_tokens"]);
    // The only text columns are the two foreign keys.
    expect(Object.entries(byName).filter(([, t]) => t === "text").map(([n]) => n).sort()).toEqual(["model_id", "user_id"]);
  });

  test("a turn writes one row per user, day and model, and tool calls are counted", async () => {
    const ada = await createUser();
    const { main } = await stubModels();
    await chat(ada, "Search for river facts");
    await chat(ada, "Plain question now");
    const rows = await db.selectFrom("usage_daily").selectAll().where("user_id", "=", ada.id).where("model_id", "=", main).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messages: 2, tool_calls: 1 });
    expect(Number(rows[0]!.weighted_tokens)).toBe((await usage(ada)).tokens.used);
  });
});

describe("rate limits", () => {
  test("sends trip the per-user limit (30 a minute) with 429 RATE_LIMITED when RATE_LIMITS is on", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const prev = process.env.RATE_LIMITS;
    process.env.RATE_LIMITS = "on";
    try {
      // An unknown attachment fails right after the limiter, so no turn starts.
      const body = { content: "hi", fileIds: [newId()] };
      for (let i = 0; i < 30; i++) expect((await as(ada).post("/api/chats/new/messages").send(body)).body.code).toBe("FILE_NOT_FOUND");
      const limited = await as(ada).post("/api/chats/new/messages").send(body).expect(429);
      expect(limited.body.code).toBe("RATE_LIMITED");
      // Regenerate shares the same budget; another user has their own.
      expect((await as(ada).post(`/api/messages/${newId()}/regenerate`).send({})).status).toBe(429);
      expect((await as(bob).post("/api/chats/new/messages").send(body)).body.code).toBe("FILE_NOT_FOUND");
    } finally {
      if (prev === undefined) delete process.env.RATE_LIMITS;
      else process.env.RATE_LIMITS = prev;
    }
  });
});
