/**
 * Runs before each test file imports anything, so the API's config module sees test
 * values. Backend choices (STORAGE, MAIL_MODE, AWS endpoint) come from the environment
 * so scripts/test-matrix.sh can vary them.
 *
 * OPENAI_API_KEY is a canary: no response the suite fetches may ever contain it
 * (secrets.int.test.ts). The stub provider is the default model, so nothing calls OpenAI.
 */
import os from "node:os";
import path from "node:path";
import { inject } from "vitest";
import { testDatabaseUrl, testRedisUrl } from "./guard";

export const CANARY_KEY = "sk-test-canary-value";

process.env.TZ = "UTC";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl();
process.env.REDIS_URL = testRedisUrl();
process.env.JOBS_MODE = "inline";
process.env.BCRYPT_ROUNDS = "4";
process.env.REQUIRE_EMAIL_VERIFICATION ??= "true";
process.env.MAIL_MODE ??= "outbox";
process.env.STORAGE ??= "local";
process.env.DATA_DIR ??= path.join(os.tmpdir(), `open-chat-test-${process.pid}`);
process.env.APP_WEB_URL ??= "http://localhost:3540";
process.env.PUBLIC_API_URL ??= "http://localhost:5036";
process.env.CORS_ORIGINS ??= "http://localhost:3540";
process.env.LOG_LEVEL ??= "silent";
process.env.STUBS_URL = inject("stubsUrl");
process.env.SEARCH_PROVIDER = "stub";
process.env.MODERATION_PROVIDER = "stub";
process.env.FETCH_ALLOW_HOSTS = "127.0.0.1";
process.env.OPENAI_API_KEY = CANARY_KEY;
