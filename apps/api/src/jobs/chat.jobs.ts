/**
 * Chat background work:
 *   chat.title      a title for a conversation whose inline title timed out
 *   chat.summarize  fold old turns into the rolling summary (services/chat/summary.ts)
 */
import { db } from "../db/kysely";
import { chatRepo } from "../repositories/chat.repository";
import { resolveChatModel } from "../services/models.service";
import { summarizeConversation } from "../services/chat/summary";
import { generateTitle } from "../services/chat/titles";
import { registerJob } from "./registry";

export function registerChatJobs(): void {
  registerJob("chat.summarize", async ({ conversationId }) => summarizeConversation(conversationId));
  registerJob("chat.title", async ({ conversationId, assistantMessageId }) => {
    const convo = await chatRepo.findConversationById(conversationId);
    const answer = await chatRepo.findMessage(assistantMessageId);
    if (!convo || convo.title_locked || !answer?.parent_id) return;
    const question = await chatRepo.findMessage(answer.parent_id);
    const model = await resolveChatModel(answer.model_id, null);
    if (!question || !model) return;
    const title = await generateTitle(model, question.content, answer.content);
    await db.updateTable("conversations").set({ title }).where("id", "=", convo.id).where("title_locked", "=", false).execute();
  });
}
