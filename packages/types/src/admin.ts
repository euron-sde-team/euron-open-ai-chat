/** The /admin control plane. Re-exported from index.ts. */
import type { UserRole, UserStatus, UserSummary } from "./index";
import type { AnswerStyle } from "./chat";

export type ProviderKind = "OPENAI" | "ANTHROPIC" | "GEMINI" | "OPENAI_COMPATIBLE" | "STUB";
export type ModelKind = "CHAT" | "IMAGE" | "TRANSCRIBE" | "SPEECH";

/** GET /api/admin/me. */
export interface AdminSession {
  role: UserRole;
}

// ─── Overview ───────────────────────────────────────────────────────────────

/** GET /api/admin/stats?from=&to=: the overview, UTC days. */
export interface AdminStats {
  from: string;
  to: string;
  totals: { users: number; newUsers: number; activeUsers: number; conversations: number; messages: number; images: number; weightedTokens: number };
  daily: { date: string; activeUsers: number; messages: number; images: number; weightedTokens: number }[];
  byModel: { modelId: string; displayName: string; messages: number; inputTokens: number; outputTokens: number }[];
  feedback: { up: number; down: number };
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface AdminUserRow extends UserSummary {
  email: string;
  status: UserStatus;
  quotaTier: { id: string; name: string } | null;
  createdAt: string;
  lastSeenAt: string | null;
  suspendedUntil: string | null;
  /** Weighted tokens used today (UTC). */
  tokensToday: number;
}

export interface AdminUserDetail extends AdminUserRow {
  override: QuotaOverride | null;
  totals: { conversations: number; messages: number; images: number; files: number };
  /** The last 30 UTC days. */
  usage: { date: string; weightedTokens: number; images: number }[];
}

export interface QuotaOverride {
  dailyTokens: number | null;
  dailyImages: number | null;
  note: string | null;
  updatedAt: string;
}

export interface QuotaTier {
  id: string;
  name: string;
  /** Null means unlimited. */
  dailyTokens: number | null;
  dailyImages: number | null;
  maxFileMb: number;
  isDefault: boolean;
  userCount: number;
}

// ─── Providers and models ───────────────────────────────────────────────────

export interface AdminProvider {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string | null;
  enabled: boolean;
  /** Whether a key for this provider is configured on the server. Never the key itself. */
  keyConfigured: boolean;
  modelCount: number;
}

export interface AdminModel {
  id: string;
  providerId: string;
  kind: ModelKind;
  modelRef: string;
  displayName: string;
  description: string;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  weight: number;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
}

/** POST /api/admin/models/:id/test: one tiny call through the real provider. */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  /** A short, key-free description of what happened. */
  message: string;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface ChatSettings {
  appName: string;
  tagline: string;
  registration: "OPEN" | "INVITE_ONLY" | "CLOSED";
  /** Email domains allowed to sign up when registration is INVITE_ONLY (["example.com"]). */
  allowedEmailDomains: string[];
  supportEmail: string | null;
  /** Server-side addition to every system prompt (house rules, tone). */
  systemPromptAddendum: string;
  features: { webSearch: boolean; imageGeneration: boolean; dictation: boolean; readAloud: boolean; memory: boolean; projects: boolean; sharing: boolean };
  defaults: { answerStyle: AnswerStyle };
  /** Delete conversations untouched for this many days; null keeps them forever. */
  retentionDays: number | null;
  minSupportedVersion: string | null;
}

/** What this deployment has configured. Never a key. */
export interface IntegrationStatus {
  search: { provider: "searxng" | "tavily" | "exa" | "brave" | "stub" | "none"; configured: boolean };
  moderation: { provider: "openai" | "stub" | "none" };
  speech: { transcribe: boolean; tts: boolean };
  mail: { mode: "outbox" | "smtp" | "ses" };
  storage: { mode: "local" | "s3" };
}

// ─── Shares and audit ───────────────────────────────────────────────────────

export interface AdminShareRow {
  id: string;
  title: string;
  owner: UserSummary;
  viewCount: number;
  revoked: boolean;
  createdAt: string;
  url: string;
}

export interface AuditEntry {
  id: string;
  actor: UserSummary | null;
  action: string;
  entityType: string;
  entityId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}
