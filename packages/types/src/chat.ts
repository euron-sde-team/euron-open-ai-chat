/** Chats, messages, files, projects, memory, images, shares and usage. Re-exported from index.ts. */

export type FilePurpose = "AVATAR" | "ATTACHMENT" | "PROJECT" | "GENERATED";
export type FileKind = "IMAGE" | "PDF" | "DOCUMENT" | "SPREADSHEET" | "TEXT" | "AUDIO" | "OTHER";
export type FileStatus = "PENDING" | "PROCESSING" | "READY" | "REJECTED" | "DELETED";
export type MessageRole = "USER" | "ASSISTANT";
export type MessageStatus = "STREAMING" | "COMPLETE" | "CANCELLED" | "FAILED";
export type AnswerStyle = "CONCISE" | "BALANCED" | "DETAILED";
export type AspectRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
export const ASPECT_RATIOS: readonly AspectRatio[] = ["1:1", "4:3", "3:4", "16:9", "9:16"];

// ─── Models ─────────────────────────────────────────────────────────────────

/** GET /api/models: what the model picker shows. Only enabled models of enabled providers. */
export interface ChatModel {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: number;
  /** How much a token counts against the daily allowance (1 = face value). */
  weight: number;
  isDefault: boolean;
}

export interface ModelCatalog {
  chat: ChatModel[];
  /** Whether image generation is available (an IMAGE model is enabled). */
  imageModel: { id: string; displayName: string } | null;
}

// ─── Files ──────────────────────────────────────────────────────────────────

/** A file as the owner sees it. Clients only ever hold ids; URLs are short-lived and signed. */
export interface ChatFile {
  id: string;
  purpose: FilePurpose;
  kind: FileKind;
  mimeType: string;
  fileName: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  pageCount: number | null;
  status: FileStatus;
  /** Why a file was rejected, in plain words. */
  rejectedReason: string | null;
  /** Signed download URL (minutes). Null until READY. */
  url: string | null;
  thumbUrl: string | null;
  createdAt: string;
}

/** POST /api/files: step one of an upload. PUT the bytes to `uploadUrl`, then POST /api/files/:id/complete. */
export interface UploadTicket {
  file: ChatFile;
  uploadUrl: string;
  /** Headers the PUT must send exactly (Content-Type). */
  headers: Record<string, string>;
  expiresAt: string;
}

// ─── Conversations ──────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string;
  projectId: string | null;
  pinned: boolean;
  archived: boolean;
  lastMessageAt: string;
  createdAt: string;
}

/** A web source an answer may cite as [n]. */
export interface Source {
  n: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  publishedAt: string | null;
}

/** One step the assistant took while answering, for the "Searched the web" lines. */
export interface ToolStep {
  tool: ToolName;
  label: string;
  status: "RUNNING" | "DONE" | "FAILED";
}

export type ToolName = "web_search" | "open_url" | "generate_image" | "remember" | "search_project_files";

export interface Message {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  sources: Source[];
  toolSteps: ToolStep[];
  /** INPUT files the user attached; OUTPUT images the assistant made. */
  attachments: ChatFile[];
  outputs: ChatFile[];
  model: { id: string; displayName: string } | null;
  status: MessageStatus;
  /** A stable code when FAILED (QUOTA_EXCEEDED, PROVIDER_ERROR, CONTENT_BLOCKED, ...). */
  errorCode: string | null;
  feedback: -1 | 1 | null;
  webSearch: boolean;
  /** Siblings under the same parent, oldest first, for the "2 / 3" switcher. */
  siblingIds: string[];
  createdAt: string;
  completedAt: string | null;
}

/** GET /api/chats/:id: the conversation and the branch on screen (root to current leaf). */
export interface ConversationDetail extends ConversationSummary {
  currentLeafId: string | null;
  messages: Message[];
  /** A turn still running on the server: reattach with GET /api/turns/:id/events. */
  activeTurnId: string | null;
}

/**
 * POST /api/chats/:id/messages. `parentId` is the message to answer under: omit it to
 * continue the current branch, or pass an earlier user message's parent to edit that
 * question as a new branch.
 */
export interface SendMessageInput {
  content: string;
  parentId?: string | null;
  modelId?: string;
  fileIds?: string[];
  webSearch?: boolean;
  /** "image": draw instead of answering in text. */
  mode?: "chat" | "image";
  aspectRatio?: AspectRatio;
}

/** 202 from send / regenerate when the client did not ask for an event stream. */
export interface TurnStarted {
  turnId: string;
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
}

// ─── Projects ───────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  instructions: string;
  fileCount: number;
  chatCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends Project {
  files: ChatFile[];
}

// ─── Memory and preferences ─────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  source: "USER" | "ASSISTANT";
  createdAt: string;
  updatedAt: string;
}

export interface Preferences {
  aboutMe: string;
  customInstructions: string;
  answerStyle: AnswerStyle;
  memoryEnabled: boolean;
  webSearchDefault: boolean;
  defaultModelId: string | null;
  voice: string;
}

// ─── Images ─────────────────────────────────────────────────────────────────

export interface GeneratedImage {
  id: string;
  prompt: string;
  aspectRatio: AspectRatio;
  file: ChatFile;
  model: { id: string; displayName: string } | null;
  conversationId: string | null;
  sourceImageId: string | null;
  createdAt: string;
}

// ─── Shares ─────────────────────────────────────────────────────────────────

export interface Share {
  id: string;
  title: string;
  conversationId: string | null;
  /** The public page (web origin + /share/:id). */
  url: string;
  viewCount: number;
  revoked: boolean;
  expiresAt: string | null;
  createdAt: string;
}

/** GET /api/shared/:id: the frozen snapshot anyone with the link may read. */
export interface SharedConversation {
  id: string;
  title: string;
  sharedBy: string;
  createdAt: string;
  messages: SharedMessage[];
}

export interface SharedMessage {
  id: string;
  role: MessageRole;
  content: string;
  sources: Source[];
  /** Images in the conversation, served through the share-scoped route. */
  images: { url: string; width: number | null; height: number | null }[];
  attachmentNames: string[];
  model: string | null;
  createdAt: string;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

/** GET /api/me/usage: today's use against the allowance (UTC day). Null limits mean unlimited. */
export interface Usage {
  day: string;
  tokens: { used: number; limit: number | null };
  images: { used: number; limit: number | null };
  maxFileMb: number;
  resetsAt: string;
}
