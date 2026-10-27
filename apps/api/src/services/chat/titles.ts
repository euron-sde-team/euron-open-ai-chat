/**
 * A short title for a new conversation, written by the conversation's own model from the
 * first question and the start of the answer. If the model is slow or fails, the first
 * words of the question stand in. A title the user set is never replaced.
 */
import { captureError } from "../../core/logger";
import type { ResolvedModel } from "../models.service";

const PROMPT = "Write a title of 2 to 6 words for a chat that starts with the exchange below. Reply with the title only: no quotes, no punctuation at the end, same language as the user.";

export function fallbackTitle(question: string): string {
  const words = question.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  return clean(words) || "New chat";
}

export function clean(title: string): string {
  return title
    .replace(/^["'`*#\s]+|["'`*.:!\s]+$/g, "")
    .replace(/^title:\s*/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

/** Throws only when `signal` aborted (the inline wait ran out); otherwise falls back to the question's first words. */
export async function generateTitle(model: ResolvedModel, question: string, answer: string, signal?: AbortSignal): Promise<string> {
  try {
    let out = "";
    for await (const ev of model.adapter.stream(
      {
        model: model.model.model_ref,
        maxOutputTokens: 30,
        temperature: 0.3,
        signal,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: [{ type: "text", text: `User: ${question.slice(0, 1500)}\n\nAssistant: ${answer.slice(0, 600)}` }] },
        ],
      },
      model.endpoint,
    )) {
      if (ev.type === "text") out += ev.text;
    }
    return clean(out.split("\n")[0] ?? "") || fallbackTitle(question);
  } catch (err) {
    if (signal?.aborted) throw err;
    captureError(err, { where: "chat.title" });
    return fallbackTitle(question);
  }
}
