/**
 * The rolling summary (chat.summarize): when a conversation's branch no longer fits the
 * model's window, the older turns are folded into a short summary that the context
 * builder sends instead. The summary records the last message it covers, so it is only
 * used on the branch it was written for.
 */
import { captureError } from "../../core/logger";
import { chatRepo } from "../../repositories/chat.repository";
import { resolveChatModel } from "../models.service";

/** Turns kept verbatim after the summary point: the summary covers everything older. */
export const KEEP_RECENT = 12;
const PROMPT =
  "Summarise the conversation below for your own future reference: the user's goals, decisions made, facts and numbers established, and open questions. At most 250 words, plain prose or a short list. Do not add anything that is not in the conversation.";

export async function summarizeConversation(conversationId: string): Promise<void> {
  const convo = await chatRepo.findConversationById(conversationId);
  if (!convo?.current_leaf_id) return;
  const path = await chatRepo.pathTo(convo.id, convo.current_leaf_id);
  if (path.length <= KEEP_RECENT) return;
  const cut = path.length - KEEP_RECENT;
  const older = path.slice(0, cut);
  const upto = older[older.length - 1]!;
  if (convo.summary_upto_id === upto.id) return;
  const model = await resolveChatModel(null, null);
  if (!model) return;
  const transcript = older.map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${m.content.slice(0, 4000)}`).join("\n\n");
  const previous = convo.summary && older.some((m) => m.id === convo.summary_upto_id) ? `Earlier summary:\n${convo.summary}\n\n` : "";
  try {
    let out = "";
    for await (const ev of model.adapter.stream(
      {
        model: model.model.model_ref,
        maxOutputTokens: 600,
        temperature: 0.2,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: [{ type: "text", text: `${previous}${transcript}`.slice(-120_000) }] },
        ],
      },
      model.endpoint,
    )) {
      if (ev.type === "text") out += ev.text;
    }
    if (out.trim()) await chatRepo.updateConversation(convo.id, { summary: out.trim().slice(0, 4000), summary_upto_id: upto.id });
  } catch (err) {
    captureError(err, { where: "chat.summarize", conversationId });
  }
}
