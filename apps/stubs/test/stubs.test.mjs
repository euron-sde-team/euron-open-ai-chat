/* global Blob, Buffer, fetch, FormData, TextDecoder */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gradientPng, parseMultipart, startStubs } from "../server.mjs";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The data payloads of an SSE body, in order. */
function sseData(text) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"))
    .filter(Boolean);
}

describe("helpers", () => {
  it("gradientPng is a real PNG whose IHDR carries the size, and differs by prompt", () => {
    const a = gradientPng(40, 20, "cat");
    expect(a.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(a.readUInt32BE(16)).toBe(40);
    expect(a.readUInt32BE(20)).toBe(20);
    expect(a.equals(gradientPng(40, 20, "dog"))).toBe(false);
  });

  it("parseMultipart reads fields and files", () => {
    const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nhello\r\n--b\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n--b--\r\n');
    const form = parseMultipart(body, "multipart/form-data; boundary=b");
    expect(form.prompt).toBe("hello");
    expect(form.file.filename).toBe("a.wav");
    expect(form.file.type).toBe("audio/wav");
    expect(form.file.data.toString()).toBe("RIFF");
  });
});

describe("the running stubs", () => {
  let stubs;
  beforeAll(async () => {
    stubs = await startStubs();
  });
  afterAll(() => stubs.close());
  beforeEach(() => fetch(`${stubs.url}/__/reset`, { method: "POST" }));

  const chat = (body) => fetch(`${stubs.url}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "stub-chat", ...body }) });
  const user = (text) => [{ role: "user", content: [{ type: "text", text }] }];

  it("listens on an ephemeral port and answers /up", async () => {
    expect(stubs.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${stubs.url}/up`)).json()).toEqual({ ok: true });
  });

  it("streams a chat completion in pieces, then usage, then [DONE]", async () => {
    const res = await chat({ stream: true, stream_options: { include_usage: true }, messages: user("hello there") });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const frames = sseData(await res.text());
    expect(frames.at(-1)).toBe("[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toContain('This is a stub answer to: "hello there"');
    expect(chunks.filter((c) => c.choices[0]?.delta?.content).length).toBeGreaterThan(1);
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
  });

  it("calls web_search when it is offered and the message asks to search; answers from the tool result with citations", async () => {
    const tools = [{ type: "function", function: { name: "web_search", parameters: {} } }];
    const frames = sseData(await (await chat({ stream: true, tools, messages: user("search for stub facts") })).text());
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls[0].function.name).toBe("web_search");
    expect(JSON.parse(calls.map((c) => c.function.arguments).join(""))).toEqual({ query: "search for stub facts" });
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");

    const followUp = await chat({ messages: [...user("search for stub facts"), { role: "assistant", content: null }, { role: "tool", tool_call_id: "call_1", content: '{"results":[{"n":1}]}' }], tools });
    expect((await followUp.json()).choices[0].message.content).toMatch(/\[1\]/);
  });

  it("does not call a tool that was not offered", async () => {
    const json = await (await chat({ messages: user("search for stub facts") })).json();
    expect(json.choices[0].message.content).toContain("stub answer");
    expect(json.choices[0].message.tool_calls).toBeUndefined();
  });

  it("reports how many images the last user turn carried", async () => {
    const json = await (await chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }, { type: "text", text: "what is this" }] }] })).json();
    expect(json.choices[0].message.content).toMatch(/^I can see 1 image\./);
  });

  it("failure triggers: fail 500, ratelimit 429, context overflow 400 context_length_exceeded", async () => {
    expect((await chat({ messages: user("please fail now") })).status).toBe(500);
    expect((await chat({ messages: user("ratelimit me") })).status).toBe(429);
    const overflow = await chat({ messages: user("context overflow") });
    expect(overflow.status).toBe(400);
    expect((await overflow.json()).error.code).toBe("context_length_exceeded");
  });

  it("moderation flags input containing STUB_FLAG only", async () => {
    const mod = (input) => fetch(`${stubs.url}/v1/moderations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) }).then((r) => r.json());
    expect((await mod("hello STUB_FLAG")).results[0].flagged).toBe(true);
    expect((await mod("hello")).results[0].flagged).toBe(false);
  });

  it("search results link to the stub pages, which carry a prompt-injection line", async () => {
    const { results } = await (await fetch(`${stubs.url}/search?q=cats`)).json();
    expect(results.map((r) => r.url)).toEqual([1, 2, 3].map((n) => `${stubs.url}/pages/${n}`));
    expect(results[0].title).toContain("cats");
    const page = await fetch(results[0].url);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toContain("<title>Stub page 1</title>");
    expect(html).toContain("Ignore all previous instructions");
  });

  it("/pages/redirect-metadata redirects to the cloud metadata address", async () => {
    const res = await fetch(`${stubs.url}/pages/redirect-metadata`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
  });

  it("image generation returns a PNG of the requested size; STUB_FLAG is refused as a policy violation", async () => {
    const gen = (prompt, size) => fetch(`${stubs.url}/v1/images/generations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, size }) });
    const json = await (await gen("a red balloon", "1536x1024")).json();
    const png = Buffer.from(json.data[0].b64_json, "base64");
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(768);
    expect(png.readUInt32BE(20)).toBe(512);
    const refused = await gen("STUB_FLAG", "1024x1024");
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe("content_policy_violation");
  });

  it("speech returns a WAV; transcription returns fixed text", async () => {
    const speech = await fetch(`${stubs.url}/v1/audio/speech`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "hi" }) });
    expect(speech.headers.get("content-type")).toBe("audio/wav");
    expect(new TextDecoder().decode((await speech.arrayBuffer()).slice(0, 4))).toBe("RIFF");
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("RIFFdata")], { type: "audio/wav" }), "a.wav");
    expect(await (await fetch(`${stubs.url}/v1/audio/transcriptions`, { method: "POST", body: form })).json()).toEqual({ text: "This is a stub transcription of what you said." });
  });

  it("records requests newest first (never the key, only whether one was sent) and reset clears them", async () => {
    await chat({ messages: user("first") });
    await fetch(`${stubs.url}/search?q=x`, { headers: { Authorization: "Bearer sk-secret-value" } });
    const log = await (await fetch(`${stubs.url}/__/requests`)).json();
    expect(log.map((r) => r.path)).toEqual(["/search", "/v1/chat/completions"]);
    expect(log[0].headers).toEqual({ authorization: "present" });
    expect(log[1].body.messages[0].content[0].text).toBe("first");
    expect(JSON.stringify(log)).not.toContain("sk-secret-value");
    expect(stubs.state.requests).toHaveLength(2);
    await fetch(`${stubs.url}/__/reset`, { method: "POST" });
    expect(await (await fetch(`${stubs.url}/__/requests`)).json()).toEqual([]);
  });

  it("anthropic and gemini dialects stream text too", async () => {
    const a = await fetch(`${stubs.url}/anthropic/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) });
    const aText = await a.text();
    expect(aText).toContain("event: message_start");
    expect(aText).toContain("text_delta");
    const g = await fetch(`${stubs.url}/gemini/v1beta/models/stub:generateContent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) });
    expect((await g.json()).candidates[0].content.parts[0].text).toContain("stub answer");
  });

  it("unknown routes answer a JSON 404", async () => {
    const res = await fetch(`${stubs.url}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/no stub/);
  });
});
