import { describe, expect, it } from "vitest";
import { ApiError } from "@open-chat/api-client";
import type { AdminModel, ChatSettings } from "@open-chat/types";
import {
  accountActions, adminErrorMessage, approval, dirtyGroups, groupModels, groupPatch, limitLabel, parseDomains, parseLimit, parsePreset, presetRange, settingsErrors, settingsPatch, tokensShort,
} from "@/lib/admin";
import { ADMIN_NAV, activeNavHref, navLabel } from "@/components/admin/shell/nav";
import { tierDraftErrors } from "@/components/admin/pages/quotas";
import { modelDraftErrors } from "@/components/admin/pages/models";
import { fromForm, toForm } from "@/components/admin/pages/settings";
import { auditAction } from "@/components/admin/pages/audit";

const settings: ChatSettings = {
  appName: "Team Chat",
  tagline: "Ask anything",
  registration: "OPEN",
  allowedEmailDomains: [],
  supportEmail: null,
  systemPromptAddendum: "",
  features: { webSearch: true, imageGeneration: true, dictation: true, readAloud: true, memory: true, projects: true, sharing: true },
  defaults: { answerStyle: "BALANCED" },
  retentionDays: null,
  minSupportedVersion: null,
};

describe("navigation", () => {
  it("lists the seven areas in order", () => {
    expect(ADMIN_NAV.map((i) => i.label)).toEqual(["Overview", "Users", "Models", "Quotas", "Shared links", "Settings", "Audit log"]);
  });
  it("matches the longest href, and /admin only itself", () => {
    expect(activeNavHref("/admin")).toBe("/admin");
    expect(activeNavHref("/admin/users")).toBe("/admin/users");
    expect(activeNavHref("/admin/users/abc")).toBe("/admin/users");
    expect(activeNavHref("/admin/usersx")).toBeNull();
    expect(navLabel("/admin/shares")).toBe("Shared links");
  });
});

describe("date ranges", () => {
  it("parses presets and falls back to 30 days", () => {
    expect(parsePreset("7")).toBe(7);
    expect(parsePreset("90")).toBe(90);
    expect(parsePreset("12")).toBe(30);
    expect(parsePreset("")).toBe(30);
  });
  it("counts UTC days, today included", () => {
    expect(presetRange(7, new Date("2026-10-27T23:30:00Z"))).toEqual({ from: "2026-10-21", to: "2026-10-27" });
    expect(presetRange(1, new Date("2026-01-01T00:10:00Z"))).toEqual({ from: "2026-01-01", to: "2026-01-01" });
  });
  it("computes approval only with ratings", () => {
    expect(approval(3, 1)).toBe(75);
    expect(approval(0, 0)).toBeNull();
  });
});

describe("account actions", () => {
  const base = { id: "u1", role: "USER" as const, status: "ACTIVE" as const };
  it("offers suspend, ban, erase and make admin for an active user", () => {
    const a = accountActions(base, "me");
    expect(a).toMatchObject({ makeAdmin: true, removeAdmin: false, suspend: true, unsuspend: false, ban: true, unban: false, erase: true });
  });
  it("protects admins: only remove admin", () => {
    const a = accountActions({ ...base, role: "ADMIN" }, "me");
    expect(a).toMatchObject({ removeAdmin: true, makeAdmin: false, suspend: false, ban: false, erase: false });
  });
  it("offers nothing on your own account", () => {
    const a = accountActions({ ...base, id: "me", role: "ADMIN" }, "me");
    expect(a.self).toBe(true);
    expect(Object.entries(a).filter(([k, v]) => k !== "self" && v)).toEqual([]);
  });
  it("offers the way back for suspended and banned accounts", () => {
    expect(accountActions({ ...base, status: "SUSPENDED" }, "me")).toMatchObject({ unsuspend: true, suspend: false, ban: true });
    expect(accountActions({ ...base, status: "BANNED" }, "me")).toMatchObject({ unban: true, ban: false, makeAdmin: false });
    expect(accountActions({ ...base, status: "DEACTIVATED" }, "me")).toMatchObject({ erased: true, erase: false, ban: false, suspend: false });
  });
});

describe("admin error copy", () => {
  const err = (code: string, message: string, status = 409) => new ApiError({ status, code, message });
  it("explains the guard rails", () => {
    expect(adminErrorMessage(err("LAST_ADMIN", "x"))).toMatch(/last admin/);
    expect(adminErrorMessage(err("SELF_ACTION", "x", 403))).toBe("You cannot do this to your own account.");
  });
  it("uses the server's exact words for its own codes", () => {
    expect(adminErrorMessage(err("TARGET_PROTECTED", "Demote an admin before banning them", 403))).toBe("Demote an admin before banning them.");
    expect(adminErrorMessage(err("TIER_NAME_TAKEN", "A tier with this name exists"))).toBe("A tier with this name exists.");
  });
});

describe("limits", () => {
  it("reads empty as unlimited and rejects non-numbers", () => {
    expect(parseLimit("")).toBeNull();
    expect(parseLimit(" 200,000 ")).toBe(200000);
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("-1")).toBeUndefined();
    expect(parseLimit("1.5")).toBeUndefined();
    expect(parseLimit("abc")).toBeUndefined();
  });
  it("labels null as Unlimited", () => {
    expect(limitLabel(null)).toBe("Unlimited");
    expect(limitLabel(20, "en-US")).toBe("20");
  });
  it("validates a tier draft like the API", () => {
    expect(tierDraftErrors({ name: "Pro", tokens: "", images: "50", maxFileMb: "25" })).toEqual({});
    expect(Object.keys(tierDraftErrors({ name: " ", tokens: "x", images: "1", maxFileMb: "501" })).sort()).toEqual(["maxFileMb", "name", "tokens"]);
  });
});

describe("models", () => {
  const m = (over: Partial<AdminModel>): AdminModel => ({
    id: "m",
    providerId: "openai",
    kind: "CHAT",
    modelRef: "x",
    displayName: "X",
    description: "",
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    weight: 1,
    enabled: true,
    isDefault: false,
    sortOrder: 0,
    ...over,
  });
  it("groups by kind in sort order", () => {
    const g = groupModels([m({ id: "b", displayName: "B", sortOrder: 2 }), m({ id: "img", kind: "IMAGE" }), m({ id: "a", displayName: "A", sortOrder: 1 })]);
    expect(g.CHAT.map((x) => x.id)).toEqual(["a", "b"]);
    expect(g.IMAGE.map((x) => x.id)).toEqual(["img"]);
    expect(g.SPEECH).toEqual([]);
  });
  it("shortens token counts", () => {
    expect(tokensShort(128000)).toBe("128K");
    expect(tokensShort(1_000_000)).toBe("1M");
    expect(tokensShort(512)).toBe("512");
  });
  it("validates a model draft like the API", () => {
    const ok = { providerId: "openai", kind: "CHAT" as const, modelRef: "gpt-4o", displayName: "GPT-4o", description: "", supportsVision: true, supportsTools: true, supportsReasoning: false, contextWindow: "128000", maxOutputTokens: "4096", weight: "1.5", enabled: true, isDefault: false, sortOrder: "0" };
    expect(modelDraftErrors(ok)).toEqual({});
    expect(Object.keys(modelDraftErrors({ ...ok, weight: "0", contextWindow: "100", modelRef: "" })).sort()).toEqual(["contextWindow", "modelRef", "weight"]);
  });
});

describe("settings", () => {
  it("patches only what changed, nested groups narrowed to their keys", () => {
    const draft = { ...settings, tagline: "New", features: { ...settings.features, memory: false } };
    expect(settingsPatch(settings, draft)).toEqual({ tagline: "New", features: { memory: false } });
    expect(dirtyGroups(settings, draft)).toEqual(["general", "features"]);
    expect(groupPatch(settings, draft, "features")).toEqual({ features: { memory: false } });
    expect(settingsPatch(settings, settings)).toEqual({});
  });
  it("round-trips the form, empty boxes as null", () => {
    expect(fromForm(toForm(settings))).toEqual(settings);
    const f = toForm(settings);
    expect(fromForm({ ...f, retentionDays: "90", supportEmail: " help@example.com ", minSupportedVersion: "1.2.0" })).toMatchObject({ retentionDays: 90, supportEmail: "help@example.com", minSupportedVersion: "1.2.0" });
  });
  it("validates like the API", () => {
    expect(settingsErrors(settings)).toEqual({});
    const e = settingsErrors({ ...settings, appName: "", registration: "INVITE_ONLY", retentionDays: 3, minSupportedVersion: "1.2", supportEmail: "nope" });
    expect(Object.keys(e).sort()).toEqual(["allowedEmailDomains", "appName", "minSupportedVersion", "retentionDays", "supportEmail"]);
  });
  it("cleans pasted domains", () => {
    expect(parseDomains("Example.com, @team.org https://x.io/path bad", ["team.org"])).toEqual({ added: ["example.com", "x.io"], invalid: ["bad"] });
  });
});

describe("audit filters", () => {
  it("prefers a typed prefix over the group tab", () => {
    expect(auditAction("user", "")).toBe("user.");
    expect(auditAction("user", " model.save ")).toBe("model.save");
    expect(auditAction("all", "")).toBe("");
    expect(auditAction("nope", "")).toBe("");
  });
});
