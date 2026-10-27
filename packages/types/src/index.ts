/**
 * The API contract shared by apps/api, apps/web and any native client: response shapes
 * (DTOs) and the streaming event catalogue. Timestamps are ISO-8601 strings. Ids are ULIDs.
 *
 * This package has no runtime dependencies and touches no DOM or Node API, so a React
 * Native app can vendor it as is (docs/guides/mobile-clients.md).
 *
 * Changing a shape here is a breaking change for one side or the other; every app
 * typechecks against these files, so the compiler finds every caller.
 */

// ─── Enums (mirrors db/migrations) ──────────────────────────────────────────

export const USER_ROLES = ["USER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" | "BANNED" | "DEACTIVATED";

// ─── Envelopes ──────────────────────────────────────────────────────────────

/** Keyset page: pass `nextCursor` back as `?cursor=` until it is null. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every non-2xx response. `code` is stable; switch on it, not on `error`. */
export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
  requestId?: string;
}

// ─── People ─────────────────────────────────────────────────────────────────

/** The person card shown wherever someone appears (admin lists, the audit log). */
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: UserRole;
}

export interface Me extends UserSummary {
  email: string;
  status: UserStatus;
  /** When a SUSPENDED account's suspension ends (ISO); null otherwise. */
  suspendedUntil: string | null;
  emailVerified: boolean;
  totpEnabled: boolean;
  /** Set while an account deletion is pending; signing in again cancels it. */
  deletionRequestedAt: string | null;
  /** True for admins: the account may open /admin. */
  canOpenAdmin: boolean;
}

/** GET /api/meta: public facts about this deployment, read before anyone signs in. */
export interface AppMeta {
  appName: string;
  tagline: string;
  registration: "OPEN" | "INVITE_ONLY" | "CLOSED";
  /** Which capabilities are switched on, so a client hides what it cannot use. */
  features: {
    webSearch: boolean;
    imageGeneration: boolean;
    /** Speech to text in the composer. */
    dictation: boolean;
    /** Text to speech on answers. */
    readAloud: boolean;
    memory: boolean;
    projects: boolean;
    sharing: boolean;
    /** The server can send push notifications to the native apps ("your answer is ready"). */
    push: boolean;
  };
  limits: {
    /** Largest upload a user on the default tier may send, in megabytes. */
    maxFileMb: number;
    maxFilesPerMessage: number;
    maxMessageChars: number;
    /** Mime types an attachment may have. */
    acceptedMimeTypes: string[];
  };
  support: { email: string | null };
  /** For native apps: older versions are asked to update ("1.4.0"); null when every version works. */
  minSupportedVersion: string | null;
}

export type PushPlatform = "IOS" | "ANDROID";

/** PUT /api/me/devices: an installed app that may receive push notifications. */
export interface RegisterDeviceInput {
  platform: PushPlatform;
  /** The FCM registration token. */
  token: string;
  appVersion?: string | null;
}

export interface PushDevice {
  id: string;
  platform: PushPlatform;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * POST /api/turns/:id/notify. `armed`: a push goes to your devices when the answer
 * finishes. `finished`: it already has, nothing will be sent (follow the turn instead).
 */
export interface TurnNotifyResult {
  state: "armed" | "finished";
}

export interface AuthResult {
  accessToken: string;
  /** Seconds until the access token expires; refresh through POST /api/auth/refresh. */
  expiresIn: number;
  user: Me;
}

/**
 * The same session for a native app (request header `X-Client: native`): the refresh
 * token comes back in the body instead of a cookie. Keep it in the platform keystore and
 * send it as `{ refreshToken }` to POST /api/auth/refresh and /api/auth/logout.
 */
export interface IssuedNativeSession extends AuthResult {
  refreshToken: string;
  /** ISO time after which the refresh token no longer works (sign in again). */
  refreshExpiresAt: string;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export * from "./chat";
export * from "./events";
export * from "./admin";
