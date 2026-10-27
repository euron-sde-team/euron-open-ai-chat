/**
 * The image studio and gallery (generate, edit, delete), dictation (the bytes must be
 * the audio they claim to be) and read aloud (text to speech streamed back).
 */
import type { GeneratedImage, Page, Usage } from "@open-chat/types";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { db } from "../../src/db/kysely";
import { DEFAULT_SETTINGS } from "../../src/services/settings.service";
import { getUrl, wavBytes, webmBytes } from "./files-helpers";
import { anon, as, chat, createUser, eventsOf, resetSettings, setSettings, stubModels, stubRequests } from "./harness";

describe("image studio and gallery", () => {
  test("generate, list newest first with paging, edit one, delete from the gallery", async () => {
    const ada = await createUser();
    const bob = await createUser();
    const { image } = await stubModels();
    const a = (await as(ada).post("/api/images").send({ prompt: "A watercolour harbour", aspectRatio: "9:16" }).expect(201)).body as GeneratedImage;
    expect(a).toMatchObject({ prompt: "A watercolour harbour", aspectRatio: "9:16", conversationId: null, sourceImageId: null, model: { id: image, displayName: "Stub Image" }, file: { purpose: "GENERATED", status: "READY", width: 512, height: 768 } });
    const bytes = await getUrl(a.file.url!);
    expect((await sharp(bytes.body).metadata()).format).toBe("png");

    const edited = (await as(ada).post("/api/images").send({ prompt: "Add a sailing boat", sourceImageId: a.id }).expect(201)).body as GeneratedImage;
    expect(edited.sourceImageId).toBe(a.id);
    const editCall = (await stubRequests()).find((r) => r.path === "/v1/images/edits");
    expect(editCall).toBeDefined();

    const page1 = (await as(ada).get("/api/images?limit=1").expect(200)).body as Page<GeneratedImage>;
    expect(page1.items.map((i) => i.id)).toEqual([edited.id]);
    const page2 = (await as(ada).get(`/api/images?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`).expect(200)).body as Page<GeneratedImage>;
    expect(page2.items.map((i) => i.id)).toEqual([a.id]);
    expect(((await as(bob).get("/api/images").expect(200)).body as Page<GeneratedImage>).items).toEqual([]);

    // Someone else's image cannot be edited or deleted.
    expect((await as(bob).post("/api/images").send({ prompt: "Steal", sourceImageId: a.id }).expect(404)).body.code).toBe("IMAGE_NOT_FOUND");
    await as(bob).delete(`/api/images/${a.id}`).expect(404);
    await as(ada).delete(`/api/images/${a.id}`).expect(204);
    expect(((await as(ada).get("/api/images").expect(200)).body as Page<GeneratedImage>).items.map((i) => i.id)).toEqual([edited.id]);
    expect(((await as(ada).get("/api/me/usage").expect(200)).body as Usage).images.used).toBe(2);
  });

  test("an image shown in a chat stays in the chat after it leaves the gallery", async () => {
    const ada = await createUser();
    const { started, events } = await chat(ada, "Draw a paper crane");
    const fileId = eventsOf(events, "tool.finished")[0]!.image!.id;
    const gallery = (await as(ada).get("/api/images").expect(200)).body as Page<GeneratedImage>;
    await as(ada).delete(`/api/images/${gallery.items[0]!.id}`).expect(204);
    const convo = (await as(ada).get(`/api/chats/${started.conversationId}`).expect(200)).body;
    expect(convo.messages[1].outputs.map((f: { id: string }) => f.id)).toEqual([fileId]);
  });

  test("validation, the feature switch, and moderation", async () => {
    const ada = await createUser();
    await as(ada).post("/api/images").send({ prompt: "" }).expect(400);
    await as(ada).post("/api/images").send({ prompt: "x", aspectRatio: "2:1" }).expect(400);
    await anon().post("/api/images").send({ prompt: "x" }).expect(401);
    expect((await as(ada).post("/api/images").send({ prompt: "Paint STUB_FLAG" }).expect(400)).body.code).toBe("CONTENT_BLOCKED");
    try {
      await setSettings({ features: { ...DEFAULT_SETTINGS.features, imageGeneration: false } });
      expect((await as(ada).post("/api/images").send({ prompt: "A tree" }).expect(400)).body.code).toBe("IMAGES_UNAVAILABLE");
      expect((await as(ada).post("/api/chats/new/messages").send({ content: "A tree", mode: "image" }).expect(400)).body.code).toBe("IMAGES_UNAVAILABLE");
    } finally {
      await resetSettings();
    }
  });
});

describe("dictation", () => {
  test("a real WAV or WebM is transcribed and counted against the allowance", async () => {
    const ada = await createUser();
    const wav = await as(ada).post("/api/speech/transcribe?language=en").set("Content-Type", "audio/wav").send(wavBytes()).expect(200);
    expect(wav.body).toEqual({ text: "This is a stub transcription of what you said." });
    const call = (await stubRequests()).find((r) => r.path === "/v1/audio/transcriptions")!;
    expect(call).toBeDefined();
    const webm = await as(ada).post("/api/speech/transcribe").set("Content-Type", "audio/webm;codecs=opus").send(webmBytes()).expect(200);
    expect(webm.body.text).toContain("stub transcription");
    expect(((await as(ada).get("/api/me/usage").expect(200)).body as Usage).tokens.used).toBeGreaterThan(0);
    const { transcribe } = await stubModels();
    expect(await db.selectFrom("usage_daily").select("messages").where("user_id", "=", ada.id).where("model_id", "=", transcribe).executeTakeFirst()).toBeDefined();
  });

  test("bytes that are not the declared audio are AUDIO_TYPE_MISMATCH; other types and empty bodies are refused", async () => {
    const ada = await createUser();
    expect((await as(ada).post("/api/speech/transcribe").set("Content-Type", "audio/webm").send(wavBytes()).expect(400)).body.code).toBe("AUDIO_TYPE_MISMATCH");
    expect((await as(ada).post("/api/speech/transcribe").set("Content-Type", "audio/wav").send(Buffer.from("<html><script>x</script></html>")).expect(400)).body.code).toBe("AUDIO_TYPE_MISMATCH");
    expect((await as(ada).post("/api/speech/transcribe").set("Content-Type", "video/mp4").send(wavBytes()).expect(400)).body.code).toBe("AUDIO_TYPE_NOT_ALLOWED");
    expect((await as(ada).post("/api/speech/transcribe").set("Content-Type", "audio/wav").send(Buffer.alloc(0)).expect(400)).body.code).toBe("AUDIO_EMPTY");
    await anon().post("/api/speech/transcribe").set("Content-Type", "audio/wav").send(wavBytes()).expect(401);
  });

  test("dictation turned off is 403", async () => {
    const ada = await createUser();
    try {
      await setSettings({ features: { ...DEFAULT_SETTINGS.features, dictation: false } });
      expect((await as(ada).post("/api/speech/transcribe").set("Content-Type", "audio/wav").send(wavBytes()).expect(403)).body.code).toBe("DICTATION_DISABLED");
    } finally {
      await resetSettings();
    }
  });
});

describe("read aloud", () => {
  test("streams audio for your answer, with the markdown made speakable and the voice you chose", async () => {
    const ada = await createUser();
    const bob = await createUser();
    await as(ada).patch("/api/me/preferences").send({ voice: "coral" }).expect(200);
    const { started } = await chat(ada, "Say something short");
    const res = await as(ada)
      .get(`/api/messages/${started.assistantMessageId}/speech`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/^audio\//);
    expect(res.headers["cache-control"]).toBe("no-store");
    const audio = res.body as Buffer;
    expect(audio.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(audio.length).toBeGreaterThan(1000);
    const call = (await stubRequests()).find((r) => r.path === "/v1/audio/speech")!;
    expect(call.body).toMatchObject({ voice: "coral", model: "stub-speech" });
    expect(call.body.input).not.toContain("**");

    // Another account's message is a plain 404, the same as one that does not exist.
    expect((await as(bob).get(`/api/messages/${started.assistantMessageId}/speech`).expect(404)).body.code).toBe("MESSAGE_NOT_FOUND");
    expect((await as(ada).get(`/api/messages/${started.userMessageId}/speech`).expect(404)).body.code).toBe("MESSAGE_NOT_FOUND");
  });
});
