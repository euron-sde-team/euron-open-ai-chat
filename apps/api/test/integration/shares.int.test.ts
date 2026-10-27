/**
 * Shared links: a frozen snapshot of the branch on screen, public to anyone with the
 * link, which later messages never change; revoking, expiry, a banned owner and the
 * sharing switch all take it down; its images are served only if frozen into it.
 */
import type { GeneratedImage, Share, SharedConversation } from "@open-chat/types";
import { describe, expect, test } from "vitest";
import { config } from "../../src/core/config";
import { db } from "../../src/db/kysely";
import { DEFAULT_SETTINGS } from "../../src/services/settings.service";
import { getUrl, pngBytes, uploadReady } from "./files-helpers";
import { anon, as, chat, createUser, eventsOf, resetSettings, setSettings, type TestUser } from "./harness";

async function share(user: TestUser, conversationId: string, extra: Record<string, unknown> = {}): Promise<Share> {
  return (await as(user).post("/api/shares").send({ conversationId, ...extra }).expect(201)).body as Share;
}

describe("creating and reading", () => {
  test("a frozen snapshot, readable without signing in; later messages are not in it", async () => {
    const ada = await createUser({ displayName: "Ada Example" });
    const doc = await uploadReady(ada, "ATTACHMENT", "brief.txt", "text/plain", Buffer.from("A private brief.\n"));
    const first = await chat(ada, "Explain rainbows simply", { fileIds: [doc.id] });
    const s = await share(ada, first.started.conversationId);
    expect(s).toMatchObject({ title: "Explain rainbows simply", conversationId: first.started.conversationId, viewCount: 0, revoked: false, expiresAt: null, url: `${config.APP_WEB_URL}/share/${s.id}` });
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{22}$/);

    await chat(ada, "A later private follow up", { conversationId: first.started.conversationId });

    const res = await anon().get(`/api/shared/${s.id}`).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
    const shared = res.body as SharedConversation;
    expect(shared).toMatchObject({ id: s.id, title: "Explain rainbows simply", sharedBy: "Ada Example" });
    expect(shared.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(shared.messages[0]).toMatchObject({ content: "Explain rainbows simply", attachmentNames: ["brief.txt"], images: [] });
    expect(shared.messages[1]).toMatchObject({ model: "Stub Pro", content: eventsOf(first.events, "message.completed")[0]!.content });
    const text = JSON.stringify(shared);
    expect(text).not.toContain("A later private follow up");
    // Attachments appear by name only (the stub answer echoes what it read, which is the model's output, not the file).
    expect(Object.keys(shared.messages[0]!).sort()).toEqual(["attachmentNames", "content", "createdAt", "id", "images", "model", "role", "sources"]);
    expect(text).not.toContain(ada.email);
    expect(text).not.toContain("files/");

    await anon().get(`/api/shared/${s.id}`).expect(200);
    const mine = (await as(ada).get("/api/shares").expect(200)).body as Share[];
    expect(mine.find((x) => x.id === s.id)!.viewCount).toBe(2);
  });

  test("deleting the conversation does not change the link; revoking takes it down at once", async () => {
    const ada = await createUser();
    const { started } = await chat(ada, "Keep this shared");
    const s = await share(ada, started.conversationId);
    await as(ada).delete(`/api/chats/${started.conversationId}`).expect(204);
    expect(((await anon().get(`/api/shared/${s.id}`).expect(200)).body as SharedConversation).messages).toHaveLength(2);
    await as(ada).delete(`/api/shares/${s.id}`).expect(204);
    expect((await anon().get(`/api/shared/${s.id}`).expect(404)).body.code).toBe("SHARE_NOT_FOUND");
    await as(ada).delete(`/api/shares/${s.id}`).expect(404);
  });

  test("rules: your own chat only, something to share, the sharing switch, expiry", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const { started } = await chat(ada, "Rules check");
    expect((await as(bob).post("/api/shares").send({ conversationId: started.conversationId }).expect(404)).body.code).toBe("CONVERSATION_NOT_FOUND");
    const empty = (await as(ada).post("/api/chats").send({}).expect(201)).body;
    expect((await as(ada).post("/api/shares").send({ conversationId: empty.id }).expect(400)).body.code).toBe("SHARE_EMPTY");
    const s = await share(ada, started.conversationId, { expiresInDays: 7 });
    expect(new Date(s.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await as(bob).delete(`/api/shares/${s.id}`).expect(404);

    try {
      await setSettings({ features: { ...DEFAULT_SETTINGS.features, sharing: false } });
      expect((await as(ada).post("/api/shares").send({ conversationId: started.conversationId }).expect(403)).body.code).toBe("SHARING_DISABLED");
      await anon().get(`/api/shared/${s.id}`).expect(404);
    } finally {
      await resetSettings();
    }
    await anon().get(`/api/shared/${s.id}`).expect(200);
    await db.updateTable("shares").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", s.id).execute();
    await anon().get(`/api/shared/${s.id}`).expect(404);
    // Malformed ids are refused before any lookup.
    expect((await anon().get("/api/shared/not-a-share").expect(404)).body.code).toBe("SHARE_NOT_FOUND");
  });

  test("a banned owner's links stop working", async () => {
    const ada = await createUser();
    const { started } = await chat(ada, "Shared before the ban");
    const s = await share(ada, started.conversationId);
    await db.updateTable("users").set({ status: "BANNED" }).where("id", "=", ada.id).execute();
    await anon().get(`/api/shared/${s.id}`).expect(404);
  });
});

describe("images in a share", () => {
  test("only image files frozen into the snapshot are served, through a short-lived redirect", async () => {
    const ada = await createUser();
    const photo = await uploadReady(ada, "ATTACHMENT", "photo.png", "image/png", await pngBytes());
    const drawn = await chat(ada, "Draw a fox in the snow", { fileIds: [photo.id] });
    const outputId = eventsOf(drawn.events, "tool.finished")[0]!.image!.id;
    const s = await share(ada, drawn.started.conversationId);
    const shared = (await anon().get(`/api/shared/${s.id}`).expect(200)).body as SharedConversation;
    expect(shared.messages[0]!.images).toHaveLength(1);
    expect(shared.messages[1]!.images).toEqual([{ url: `${config.PUBLIC_API_URL}/api/shared/${s.id}/images/${outputId}`, width: 512, height: 512 }]);

    const redirect = await anon().get(`/api/shared/${s.id}/images/${outputId}`).expect(302);
    expect(redirect.headers["cache-control"]).toBe("private, no-store");
    const img = await getUrl(redirect.headers.location!);
    expect(img.status).toBe(200);
    expect(img.type).toBe("image/png");
    await anon().get(`/api/shared/${s.id}/images/${photo.id}`).expect(302);

    // An image of the same owner that is not in the snapshot is not reachable through the link.
    const other = (await as(ada).post("/api/images").send({ prompt: "A different picture" }).expect(201)).body as GeneratedImage;
    await anon().get(`/api/shared/${s.id}/images/${other.file.id}`).expect(404);
    // Nor through someone else's link.
    const bob = await createUser();
    const bobChat = await chat(bob, "Bob shares too");
    const bobShare = await share(bob, bobChat.started.conversationId);
    await anon().get(`/api/shared/${bobShare.id}/images/${outputId}`).expect(404);
    // Revoked: nothing.
    await as(ada).delete(`/api/shares/${s.id}`).expect(204);
    await anon().get(`/api/shared/${s.id}/images/${outputId}`).expect(404);
  });
});
