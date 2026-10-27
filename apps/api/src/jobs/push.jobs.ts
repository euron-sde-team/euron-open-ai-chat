/** Push background work: push.turn-ready, the "your answer is ready" notification (services/push.service.ts). */
import { sendTurnReady } from "../services/push.service";
import { registerJob } from "./registry";

export function registerPushJobs(): void {
  registerJob("push.turn-ready", sendTurnReady);
}
