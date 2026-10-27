/**
 * Demo data so a fresh install has something to look at. Run with `make demo` (or
 * `node dist/cli.js demo:seed`).
 *
 *   - the starter model catalogue plus the local stub provider (services answer through it)
 *   - an admin and four people, one of them with a full history: pinned and dated chats,
 *     a regenerated answer kept as a second branch, web sources with citations, an image
 *     they attached, images the assistant made, a project with a knowledge file, memories
 *     and a shared link
 *   - thirty days of usage for every account, for the admin overview
 *
 * Images are SVG scenes rendered to PNG in code: no stock photos, no faces. Refuses to run
 * with NODE_ENV=production. If the demo admin exists it prints the logins and exits.
 */
import crypto from "node:crypto";
import sharp from "sharp";
import { sql } from "kysely";
import type { Source, ToolStep } from "@open-chat/types";
import { config } from "../core/config";
import { newId } from "../core/ids";
import { db } from "../db/kysely";
import { estimateTokens } from "../domain/chunking";
import { storage } from "../integrations/storage";
import { closeRedis } from "../integrations/redis";
import { closeQueues } from "../jobs/registry";
import { hashPassword } from "../security/passwords";
import { processFile, storeGenerated } from "../services/file.service";
import { createShare } from "../services/share.service";
import { storageKeyFor } from "../domain/file-rules";
import { ensureStarterCatalog } from "./catalog";
import { CONVERSATIONS, LAUNCH_DOC, MEMORIES, SCENES, type DemoTurn } from "./content";

const ADMIN_EMAIL = "admin@example.com";
const HOUR = 3_600_000;

const PEOPLE = [
  { email: "priya.nair@example.com", username: "priya-nair", name: "Priya Nair", main: true },
  { email: "leo.marquez@example.com", username: "leo-marquez", name: "Leo Marquez" },
  { email: "sam.kowalski@example.com", username: "sam-kowalski", name: "Sam Kowalski" },
  { email: "amara.okafor@example.com", username: "amara-okafor", name: "Amara Okafor" },
];

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261027);

async function png(scene: keyof typeof SCENES): Promise<Buffer> {
  return sharp(Buffer.from(SCENES[scene])).png().toBuffer();
}

/** Store an attachment the way an upload ends up after processing. */
async function storeAttachment(ownerId: string, data: Buffer, mime: string, name: string, kind: "IMAGE" | "TEXT", purpose: "ATTACHMENT" | "PROJECT"): Promise<string> {
  const id = newId();
  const key = storageKeyFor(purpose, id, kind === "IMAGE" ? "png" : "md");
  await storage().put(key, data, kind === "IMAGE" ? mime : "text/plain; charset=utf-8");
  await db
    .insertInto("files")
    .values({ id, owner_id: ownerId, purpose, kind, mime_type: mime, file_name: name, declared_size: data.length, size_bytes: data.length, storage_key: key, status: "PROCESSING", completed_at: new Date() })
    .execute();
  await processFile(id);
  return id;
}

export async function seedDemo(): Promise<void> {
  if (config.NODE_ENV === "production") throw new Error("demo:seed refuses to run in production");
  const password = config.DEMO_PASSWORD ?? crypto.randomBytes(9).toString("base64url");
  const existing = await db.selectFrom("users").select("id").where("email", "=", ADMIN_EMAIL).executeTakeFirst();
  if (existing) {
    printLogins(config.DEMO_PASSWORD ? password : null);
    return;
  }
  const models = await ensureStarterCatalog(db, { includeStub: true });
  if (!models) throw new Error("the stub provider was not created");
  const hash = await hashPassword(password);
  const now = Date.now();

  const adminId = newId();
  await db.insertInto("users").values({ id: adminId, email: ADMIN_EMAIL, username: "admin", display_name: "Morgan Ellis", password_hash: hash, role: "ADMIN", status: "ACTIVE", email_verified_at: new Date(now - 40 * 24 * HOUR), created_at: new Date(now - 40 * 24 * HOUR) }).execute();
  const staffTier = newId();
  await db.insertInto("quota_tiers").values({ id: staffTier, name: "Staff", daily_tokens: 2_000_000, daily_images: 100, max_file_mb: 100 }).execute();

  const ids: Record<string, string> = {};
  for (const [i, p] of PEOPLE.entries()) {
    const id = newId();
    ids[p.username] = id;
    await db
      .insertInto("users")
      .values({ id, email: p.email, username: p.username, display_name: p.name, password_hash: hash, role: "USER", status: "ACTIVE", email_verified_at: new Date(now - (30 - i) * 24 * HOUR), created_at: new Date(now - (30 - i) * 24 * HOUR), quota_tier_id: i === 1 ? staffTier : null, last_seen_at: new Date(now - i * HOUR) })
      .execute();
  }
  const main = ids["priya-nair"]!;
  await db.insertInto("user_preferences").values({ user_id: main, about_me: "Product manager at a collaboration software company.", custom_instructions: "Be direct. Prefer tables when comparing options.", answer_style: "BALANCED" }).execute();
  for (const [i, m] of MEMORIES.entries()) await db.insertInto("memories").values({ id: newId(), user_id: main, content: m, source: i % 2 ? "USER" : "ASSISTANT", created_at: new Date(now - (i + 2) * 24 * HOUR) }).execute();

  // A project with a knowledge file the assistant searches.
  const projectId = newId();
  await db.insertInto("projects").values({ id: projectId, user_id: main, name: "Q3 launch: Team Workspaces", instructions: "Answer as a launch lead. Cite the brief when you use it.", created_at: new Date(now - 9 * 24 * HOUR) }).execute();
  const docId = await storeAttachment(main, Buffer.from(LAUNCH_DOC.text), "text/markdown", LAUNCH_DOC.name, "TEXT", "PROJECT");
  await db.insertInto("project_files").values({ project_id: projectId, file_id: docId }).execute();

  let shareConversation: string | null = null;
  for (const c of CONVERSATIONS) {
    const convoId = newId();
    const started = new Date(now - c.hoursAgo * HOUR);
    await db.insertInto("conversations").values({ id: convoId, user_id: main, project_id: c.project ? projectId : null, title: c.title, pinned_at: c.pinned ? started : null, last_message_at: started, created_at: started }).execute();
    let parent: string | null = null;
    let t = started.getTime();
    for (const turn of c.turns) {
      const leaf = await seedTurn(main, convoId, parent, turn, models, t);
      parent = leaf;
      t += 4 * 60_000;
    }
    await db.updateTable("conversations").set({ current_leaf_id: parent, last_message_at: new Date(t) }).where("id", "=", convoId).execute();
    if (c.title === "How HTTPS works") shareConversation = convoId;
  }
  if (shareConversation) await createShare({ id: main, username: "priya-nair", displayName: "Priya Nair", role: "USER", status: "ACTIVE" }, shareConversation, { expiresInDays: null });

  // A few chats for the other people, so the admin numbers are not one person's.
  for (const username of ["leo-marquez", "sam-kowalski", "amara-okafor"]) {
    const who = ids[username]!;
    for (const c of CONVERSATIONS.slice(8, 11)) {
      const convoId = newId();
      const at = new Date(now - (c.hoursAgo + rand() * 48) * HOUR);
      await db.insertInto("conversations").values({ id: convoId, user_id: who, title: c.title, last_message_at: at, created_at: at }).execute();
      const leaf = await seedTurn(who, convoId, null, c.turns[0]!, models, at.getTime());
      await db.updateTable("conversations").set({ current_leaf_id: leaf }).where("id", "=", convoId).execute();
    }
  }

  // Thirty days of usage for the admin overview.
  for (const userId of [main, ...Object.values(ids).filter((x) => x !== main)]) {
    for (let d = 0; d < 30; d++) {
      if (rand() < 0.25) continue;
      const day = new Date(now - d * 24 * HOUR).toISOString().slice(0, 10);
      const msgs = Math.ceil(rand() * 30);
      const input = msgs * (800 + Math.floor(rand() * 2400));
      const output = msgs * (300 + Math.floor(rand() * 900));
      await db
        .insertInto("usage_daily")
        .values({ user_id: userId, day: sql<Date>`${day}::date`, model_id: rand() < 0.8 ? models.main : models.lite, messages: msgs, input_tokens: input, output_tokens: output, weighted_tokens: input + output, images: rand() < 0.3 ? Math.ceil(rand() * 3) : 0, tool_calls: Math.floor(msgs / 3) })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
  printLogins(password);
  await closeQueues();
  await closeRedis();
}

async function seedTurn(userId: string, convoId: string, parent: string | null, turn: DemoTurn, models: { main: string; lite: string }, at: number): Promise<string> {
  const qId = newId();
  await db.insertInto("messages").values({ id: qId, conversation_id: convoId, parent_id: parent, role: "USER", content: turn.user, created_at: new Date(at), completed_at: new Date(at) }).execute();
  if (turn.attachImage) {
    const fid = await storeAttachment(userId, await png(turn.attachImage), "image/png", "whiteboard.png", "IMAGE", "ATTACHMENT");
    await db.insertInto("message_files").values({ message_id: qId, file_id: fid, direction: "INPUT", position: 0 }).execute();
  }
  const answer = async (content: string, model: "main" | "lite", when: number, withExtras: boolean) => {
    const aId = newId();
    const sources: Source[] = withExtras ? (turn.sources ?? []).map((s, i) => ({ n: i + 1, title: s.title, url: s.url, domain: new URL(s.url).hostname, snippet: s.snippet, publishedAt: null })) : [];
    const steps: ToolStep[] = withExtras ? (turn.steps ?? []).map((s) => ({ ...s, status: "DONE" as const })) : [];
    await db
      .insertInto("messages")
      .values({
        id: aId,
        conversation_id: convoId,
        parent_id: qId,
        role: "ASSISTANT",
        content,
        sources: JSON.stringify(sources),
        tool_trace: JSON.stringify(steps),
        model_id: model === "lite" ? models.lite : models.main,
        status: "COMPLETE",
        finish_reason: "stop",
        input_tokens: estimateTokens(turn.user) + 600,
        output_tokens: estimateTokens(content),
        feedback: withExtras ? (turn.feedback ?? null) : null,
        web_search: !!sources.length,
        created_at: new Date(when),
        completed_at: new Date(when + 6000),
      })
      .execute();
    if (withExtras && turn.image) {
      const file = await storeGenerated(userId, await png(turn.image.scene), "image/png", `image-${turn.image.scene}.png`);
      await db.insertInto("message_files").values({ message_id: aId, file_id: file.id, direction: "OUTPUT", position: 0 }).execute();
      const imageModel = await db.selectFrom("models").select("id").where("provider_id", "=", "stub").where("kind", "=", "IMAGE").executeTakeFirst();
      await db.insertInto("images").values({ id: newId(), user_id: userId, file_id: file.id, prompt: turn.image.prompt, model_id: imageModel?.id ?? null, conversation_id: convoId, message_id: aId, created_at: new Date(when) }).execute();
    }
    return aId;
  };
  // The alternative answer is older, so the main answer is the newest sibling (shown 2 / 2).
  if (turn.alternative) await answer(turn.alternative.assistant, turn.alternative.model ?? "main", at + 30_000, false);
  return answer(turn.assistant, turn.model ?? "main", at + 90_000, true);
}

function printLogins(password: string | null): void {
  const lines = [
    "",
    "  Demo accounts (all share one password):",
    `    admin     ${ADMIN_EMAIL}`,
    ...PEOPLE.map((p) => `    ${p.main ? "main     " : "user     "} ${p.email}`),
    password ? "" : "  The password was printed when the demo was first seeded (DEMO_PASSWORD in deploy/compose/.env).",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
