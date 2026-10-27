import { isApiError } from "@open-chat/api-client";

/** Human copy for the API's stable error codes. Unknown codes fall back to the server message. */
const COPY: Record<string, string> = {
  NETWORK_ERROR: "We could not reach the server. Check your connection and try again.",
  SERVER_ERROR: "Something went wrong on our side. Try again in a moment.",
  BAD_GATEWAY: "The service is restarting. Try again in a moment.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable. Try again in a moment.",
  GATEWAY_TIMEOUT: "The server took too long to answer. Try again.",
  RATE_LIMITED: "You are doing that too fast. Wait a moment and try again.",
  UNAUTHENTICATED: "Sign in to continue.",
  TOKEN_INVALID: "This link is invalid or has expired.",
  SESSION_EXPIRED: "Your session expired. Sign in again.",
  FORBIDDEN: "You do not have permission to do that.",
  FORBIDDEN_ADMIN: "Only administrators can do that.",
  NOT_FOUND: "We could not find that. It may have been removed.",
  VALIDATION_FAILED: "Some fields need attention.",
  INVALID_CREDENTIALS: "That email, username or password is not right.",
  INVALID_TOTP: "That code did not work. Check your authenticator app and try again.",
  ACCOUNT_BANNED: "This account has been banned.",
  ACCOUNT_DEACTIVATED: "This account has been deactivated.",
  ACCOUNT_RESTRICTED: "Your account is restricted: you can read your chats but not send.",
  EMAIL_NOT_VERIFIED: "Confirm your email address first. Check your inbox for the link.",
  EMAIL_TAKEN: "An account with that email already exists.",
  USERNAME_TAKEN: "That username is taken. Try another.",
  WEAK_PASSWORD: "Choose a stronger password: at least 10 characters, not a common one.",
  REGISTRATION_CLOSED: "Sign-ups are closed right now.",
  REGISTRATION_DOMAIN_NOT_ALLOWED: "Sign-up is open to approved email domains only. Use your work address.",
  USERNAME_RESERVED: "That username is reserved. Try another.",
  LAST_ADMIN: "You are the last administrator. Make someone else an admin first.",
  SELF_ACTION: "You cannot do that to your own account.",
  TARGET_PROTECTED: "Administrators cannot be suspended or banned. Remove their admin role first.",
  PAYLOAD_TOO_LARGE: "That is too large.",
  FILE_TOO_LARGE: "That file is larger than your limit allows.",
  FILE_TYPE_NOT_ALLOWED: "This kind of file cannot be attached.",
  FILE_EXTENSION_MISMATCH: "The file's extension does not match its type.",
  FILE_TYPE_MISMATCH: "The file's content does not match its type.",
  FILE_NOT_READY: "A file is still being processed. Try again in a moment.",
  FILE_REJECTED: "A file could not be read.",
  FILE_IN_USE: "This file is part of a conversation. Delete the conversation to remove it.",
  MODEL_NO_VISION: "This model cannot see images. Pick a model with vision.",
  MODEL_UNAVAILABLE: "No model is available right now. Ask an administrator to configure one.",
  IMAGES_UNAVAILABLE: "Image generation is not available.",
  QUOTA_EXCEEDED: "You have used today's allowance. It resets at midnight UTC.",
  TURN_IN_PROGRESS: "An answer is still being written in this chat. Wait for it or stop it.",
  MESSAGE_TOO_LONG: "That message is too long.",
  TOO_MANY_FILES: "That is too many files for one message.",
  CONTENT_BLOCKED: "This request cannot be answered.",
  SHARING_DISABLED: "Sharing is turned off.",
  SHARE_EMPTY: "There is nothing to share yet.",
  MEMORY_LIMIT: "Memory is full. Delete some memories first.",
  PROJECT_LIMIT: "You have reached the project limit.",
  AUDIO_TYPE_NOT_ALLOWED: "That audio format is not supported.",
  AUDIO_TYPE_MISMATCH: "That audio could not be read.",
  DICTATION_DISABLED: "Dictation is turned off.",
  READ_ALOUD_DISABLED: "Read aloud is turned off.",
};

export function errorCopy(code: string | undefined, fallback?: string): string {
  if (code && COPY[code]) return COPY[code];
  return fallback || "Something went wrong. Try again.";
}

/** The best human message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    // Validation messages from the server are already field-specific and readable.
    if (e.code === "VALIDATION_FAILED") {
      const first = Object.values(e.fieldErrors)[0];
      return first ? `${COPY.VALIDATION_FAILED} ${capitalise(first)}.` : COPY.VALIDATION_FAILED!;
    }
    return errorCopy(e.code, e.message);
  }
  if (e instanceof Error && e.name === "AbortError") return "Cancelled.";
  return errorCopy(undefined);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/\.$/, "");

/** Errors not worth a toast: the page already shows them in place. */
export function isQuietError(e: unknown): boolean {
  if (isApiError(e)) return e.status === 404 || e.status === 401 || e.code === "VALIDATION_FAILED";
  return e instanceof Error && e.name === "AbortError";
}
