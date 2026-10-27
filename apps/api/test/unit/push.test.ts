import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { assertProductionConfig, loadConfig, productionWarnings, pushEnabled } from "../../src/core/config";
import { fcmMessage, isDeadToken, parseServiceAccount, signAssertion } from "../../src/integrations/push/fcm";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = { project_id: "demo", client_email: "push@demo.example.test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

describe("FCM HTTP v1", () => {
  test("the service account JSON needs its three fields; the placeholder is unset", () => {
    expect(parseServiceAccount(JSON.stringify(account))).toEqual(account);
    expect(parseServiceAccount("set-me")).toBeNull();
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount("{not json")).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: "x" }))).toBeNull();
  });

  test("the JWT assertion is RS256 over header.claims with the messaging scope and an hour's lifetime", () => {
    const jwt = signAssertion(account, "https://oauth2.example.test/token", 1_700_000_000);
    const [h, c, sig] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.example.test/token", iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  test("message shape and dead-token detection", () => {
    expect(fcmMessage({ token: "t", platform: "IOS", title: "T", body: "B", data: { type: "turn", conversationId: "c" } })).toMatchObject({
      token: "t",
      notification: { title: "T", body: "B" },
      data: { type: "turn", conversationId: "c" },
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    expect(isDeadToken(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } })).toBe(true);
    expect(isDeadToken(400, { error: { status: "INVALID_ARGUMENT" } })).toBe(true);
    expect(isDeadToken(429, { error: { status: "RESOURCE_EXHAUSTED", details: [{ errorCode: "QUOTA_EXCEEDED" }] } })).toBe(false);
    expect(isDeadToken(500, null)).toBe(false);
  });
});

describe("push configuration", () => {
  const base = { NODE_ENV: "test" };
  const sa = JSON.stringify(account);

  test("off by default; fcm needs a parseable service account; stub is always on", () => {
    expect(pushEnabled(loadConfig(base))).toBe(false);
    expect(pushEnabled(loadConfig({ ...base, PUSH_PROVIDER: "fcm" }))).toBe(false);
    expect(pushEnabled(loadConfig({ ...base, PUSH_PROVIDER: "fcm", FCM_SERVICE_ACCOUNT_JSON: "set-me" }))).toBe(false);
    expect(pushEnabled(loadConfig({ ...base, PUSH_PROVIDER: "fcm", FCM_SERVICE_ACCOUNT_JSON: sa }))).toBe(true);
    expect(pushEnabled(loadConfig({ ...base, PUSH_PROVIDER: "stub" }))).toBe(true);
  });

  test("stub is refused in production; fcm without a service account is a warning; preview is off by default", () => {
    expect(assertProductionConfig(loadConfig({ ...base, PUSH_PROVIDER: "stub" }))).toContain("PUSH_PROVIDER=stub is a test double");
    expect(productionWarnings(loadConfig({ ...base, PUSH_PROVIDER: "fcm" })).join("\n")).toMatch(/FCM_SERVICE_ACCOUNT_JSON is missing or invalid/);
    expect(productionWarnings(loadConfig({ ...base, PUSH_PROVIDER: "fcm", FCM_SERVICE_ACCOUNT_JSON: sa })).join("\n")).not.toMatch(/FCM_SERVICE_ACCOUNT_JSON/);
    expect(loadConfig(base).PUSH_PREVIEW).toBe(false);
    expect(loadConfig({ ...base, PUSH_PREVIEW: "true" }).PUSH_PREVIEW).toBe(true);
  });
});
