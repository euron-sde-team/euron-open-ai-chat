/**
 * Background jobs. A job is a named handler with a JSON payload. Services enqueue jobs
 * through `Effects.job(...)`, so nothing is enqueued for a transaction that rolled back.
 *
 * JOBS_MODE=queue  BullMQ on Redis; the worker process (worker.ts) runs the handlers.
 * JOBS_MODE=inline the handler runs in-process right after commit. Used by the
 *                  integration tests so assertions are deterministic.
 */
import { Queue, type JobsOptions } from "bullmq";
import { config } from "../core/config";
import { captureError, logger } from "../core/logger";
import { redisConnection } from "../integrations/redis";

export const QUEUES = ["files", "chat", "push", "maintenance"] as const;
export type QueueName = (typeof QUEUES)[number];

export interface JobDefinitions {
  /** Re-encode an image or read a document, then mark the file READY (services/file.service.ts). */
  "files.process": { fileId: string };
  /** Give a conversation a short title from its first exchange (services/chat/titles.ts). */
  "chat.title": { conversationId: string; assistantMessageId: string };
  /** Fold turns that no longer fit the context budget into the rolling summary (services/chat/context.ts). */
  "chat.summarize": { conversationId: string };
  /** "Your answer is ready" to the devices of someone who asked for it (services/push.service.ts). */
  "push.turn-ready": { userId: string; conversationId: string; messageId: string; ok: boolean };
  "maintenance.expire-files": Record<string, never>;
  "maintenance.lift-suspensions": Record<string, never>;
  /** Erase accounts whose deletion grace period is over. */
  "maintenance.purge-accounts": Record<string, never>;
  /** Mark turns stuck in STREAMING (a crashed task) as FAILED. */
  "maintenance.sweep-turns": Record<string, never>;
  /** Delete conversations older than the retention setting, when one is set. */
  "maintenance.retention": Record<string, never>;
}
export type JobName = keyof JobDefinitions;

type Handler<N extends JobName> = (data: JobDefinitions[N]) => Promise<void>;
const handlers = new Map<JobName, Handler<any>>();

export function registerJob<N extends JobName>(name: N, handler: Handler<N>): void {
  handlers.set(name, handler);
}

export function getHandler<N extends JobName>(name: N): Handler<N> | undefined {
  return handlers.get(name);
}

export function queueFor(name: JobName): QueueName {
  return name.split(".")[0] as QueueName;
}

const queues = new Map<QueueName, Queue>();
function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: redisConnection(),
      defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue<N extends JobName>(name: N, data: JobDefinitions[N], opts: JobsOptions = {}): Promise<void> {
  if (config.JOBS_MODE === "inline") {
    const handler = getHandler(name);
    if (!handler) {
      logger.warn({ job: name }, "inline job has no handler registered");
      return;
    }
    try {
      await handler(data);
    } catch (err) {
      captureError(err, { job: name });
    }
    return;
  }
  await queue(queueFor(name)).add(name, data, opts);
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
