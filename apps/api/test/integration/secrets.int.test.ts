/**
 * Provider keys never leave the server. OPENAI_API_KEY is set to a canary value for the
 * whole suite (env.ts); this file walks every kind of response a user and an admin can
 * fetch, event streams included, and the database, and asserts the canary is nowhere.
 */
import { describe, expect, test } from "vitest";
import { sql } from "kysely";
import { db } from "../../src/db/kysely";
import { CANARY_KEY } from "./env";
import { pngBytes, uploadReady } from "./files-helpers";
import { anon, as, asText, chat, createUser, stubModels } from "./harness";

describe("the provider key canary", () => {
  test("appears in no response a user or an admin can fetch", async () => {
    expect(process.env.OPENAI_API_KEY).toBe(CANARY_KEY);
    const user = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const { main, image } = await stubModels();
    await uploadReady(user, "ATTACHMENT", "a.png", "image/png", await pngBytes());
    const ok = await chat(user, "Search for canary birds");
    const failed = await chat(user, "Please fail loudly");
    const share = (await as(user).post("/api/shares").send({ conversationId: ok.started.conversationId }).expect(201)).body;
    await as(user).post("/api/images").send({ prompt: "A yellow canary" }).expect(201);

    const bodies: string[] = [JSON.stringify(ok.events), JSON.stringify(failed.events)];
    const userGets = ["/api/meta", "/api/models", "/api/me/usage", "/api/me/preferences", "/api/users/me", "/api/chats", `/api/chats/${ok.started.conversationId}`, `/api/chats/${failed.started.conversationId}`, "/api/files", "/api/images", "/api/memories", "/api/projects", "/api/shares", "/api/users/me/sessions"];
    for (const url of userGets) bodies.push((await as(user).get(url).expect(200)).text);
    bodies.push((await anon().get(`/api/shared/${share.id}`).expect(200)).text);
    bodies.push((await asText(as(user).get(`/api/turns/${ok.started.turnId}/events`)).expect(200)).body as string);
    bodies.push((await asText(as(user).get("/api/users/me/export")).expect(200)).body as string);

    const adminGets = ["/api/admin/me", "/api/admin/stats", "/api/admin/users", `/api/admin/users/${user.id}`, "/api/admin/tiers", "/api/admin/providers", "/api/admin/models", "/api/admin/settings", "/api/admin/integrations", "/api/admin/shares", "/api/admin/audit?limit=100"];
    for (const url of adminGets) bodies.push((await as(admin).get(url).expect(200)).text);
    bodies.push((await as(admin).post(`/api/admin/models/${main}/test`).send({}).expect(200)).text);
    bodies.push((await as(admin).post(`/api/admin/models/${image}/test`).send({}).expect(200)).text);
    // Error envelopes too.
    bodies.push((await as(user).get("/api/admin/providers").expect(403)).text);
    bodies.push((await as(user).post("/api/chats/new/messages").send({ content: "" }).expect(400)).text);

    for (const b of bodies) {
      expect(b).not.toContain(CANARY_KEY);
      expect(b).not.toContain("canary-value");
    }
    // The providers list still says a key is configured, without the key.
    expect((await as(admin).get("/api/admin/providers").expect(200)).body.find((p: { id: string }) => p.id === "openai").keyConfigured).toBe(true);
  });

  test("is stored nowhere in the database", async () => {
    const hits = await sql<{ n: number }>`
      SELECT (SELECT count(*) FROM settings WHERE value::text LIKE ${`%${CANARY_KEY}%`})
           + (SELECT count(*) FROM providers WHERE coalesce(base_url, '') LIKE ${`%${CANARY_KEY}%`})
           + (SELECT count(*) FROM audit_log WHERE data::text LIKE ${`%${CANARY_KEY}%`})
           + (SELECT count(*) FROM messages WHERE content LIKE ${`%${CANARY_KEY}%`} OR sources::text LIKE ${`%${CANARY_KEY}%`}) AS n`.execute(db);
    expect(Number(hits.rows[0]!.n)).toBe(0);
  });
});
