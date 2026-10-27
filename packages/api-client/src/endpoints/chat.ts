/** Models, conversations, turns, files, projects, memory, images, shares, speech and usage. */
import type {
  AspectRatio,
  ChatFile,
  ConversationDetail,
  ConversationSummary,
  FilePurpose,
  GeneratedImage,
  Memory,
  Message,
  ModelCatalog,
  Page,
  Preferences,
  Project,
  ProjectDetail,
  PushDevice,
  RegisterDeviceInput,
  SendMessageInput,
  Share,
  SharedConversation,
  TurnEvent,
  TurnNotifyResult,
  TurnStarted,
  Usage,
} from "@open-chat/types";
import { followTurn, readEventStream, type FollowOptions } from "../stream";
import { uploadFile, type UploadOptions } from "../upload";
import { enc, type Helpers, type PageQuery } from "./helpers";

export interface ConversationQuery extends PageQuery {
  q?: string;
  projectId?: string;
  archived?: boolean;
  pinned?: boolean;
}

export function chatEndpoints(h: Helpers) {
  const { http, get, post, put, patch, del, pq } = h;

  const models = {
    catalog: (signal?: AbortSignal) => get<ModelCatalog>("/models", undefined, signal),
  };

  const me = {
    usage: () => get<Usage>("/me/usage"),
    preferences: () => get<Preferences>("/me/preferences"),
    updatePreferences: (body: Partial<Preferences>) => patch<Preferences>("/me/preferences", body),
    /** Native apps: register this install for push (call after sign-in and when the token changes). */
    registerDevice: (body: RegisterDeviceInput) => put<PushDevice>("/me/devices", body),
    removeDevice: (token: string) => del(`/me/devices/${enc(token)}`),
  };

  const chats = {
    list: (q?: ConversationQuery, signal?: AbortSignal) => get<Page<ConversationSummary>>("/chats", pq(q), signal),
    create: (body: { title?: string; projectId?: string | null } = {}) => post<ConversationSummary>("/chats", body),
    get: (id: string, signal?: AbortSignal) => get<ConversationDetail>(`/chats/${enc(id)}`, undefined, signal),
    update: (id: string, body: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null }) => patch<ConversationSummary>(`/chats/${enc(id)}`, body),
    remove: (id: string) => del(`/chats/${enc(id)}`),
    removeAll: () => del<{ deleted: number }>("/chats"),
    /** Send and get the turn id (202). Follow it with `turns.follow`. `id` may be "new". */
    send: (id: string, body: SendMessageInput & { projectId?: string | null }) => post<TurnStarted>(`/chats/${enc(id)}/messages`, body),
    /**
     * Send and stream the turn on the same response. Yields every TurnEvent; if the
     * connection drops, continue with `turns.follow(turnId, { after: lastSeq })`.
     */
    sendStreaming: async function* (id: string, body: SendMessageInput & { projectId?: string | null }, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
      const res = await http.request<Response>("POST", `/chats/${enc(id)}/messages`, { body, raw: true, signal, headers: { Accept: "text/event-stream" } });
      yield* readEventStream(res, signal);
    },
    setLeaf: (id: string, messageId: string) => put<ConversationDetail>(`/chats/${enc(id)}/leaf`, { messageId }),
  };

  const messages = {
    regenerate: (id: string, body: { modelId?: string; webSearch?: boolean } = {}) => post<TurnStarted>(`/messages/${enc(id)}/regenerate`, body),
    feedback: (id: string, value: 1 | -1 | null) => put<Message>(`/messages/${enc(id)}/feedback`, { value }),
    /** The answer read aloud (audio). */
    speech: async (id: string, signal?: AbortSignal): Promise<Blob> => (await http.request<Response>("GET", `/messages/${enc(id)}/speech`, { raw: true, signal })).blob(),
  };

  const turns = {
    /** Every event of a turn from `after`, reconnecting through dropped connections, until `done`. */
    follow: (turnId: string, opts?: FollowOptions) => followTurn(http, turnId, opts),
    cancel: (turnId: string) => http.request<void>("POST", `/turns/${enc(turnId)}/cancel`, { keepalive: true }),
    /** Native apps, going to the background mid-answer: push to my devices when this answer finishes. */
    notify: (turnId: string) => post<TurnNotifyResult>(`/turns/${enc(turnId)}/notify`, {}),
  };

  const files = {
    upload: (opts: UploadOptions) => uploadFile(http, opts),
    get: (id: string) => get<ChatFile>(`/files/${enc(id)}`),
    list: (purpose?: FilePurpose) => get<ChatFile[]>("/files", { purpose }),
    remove: (id: string) => del(`/files/${enc(id)}`),
  };

  const projects = {
    list: () => get<Project[]>("/projects"),
    get: (id: string) => get<ProjectDetail>(`/projects/${enc(id)}`),
    create: (body: { name: string; instructions?: string }) => post<ProjectDetail>("/projects", body),
    update: (id: string, body: { name?: string; instructions?: string }) => patch<ProjectDetail>(`/projects/${enc(id)}`, body),
    remove: (id: string) => del(`/projects/${enc(id)}`),
    addFile: (id: string, fileId: string) => post<ProjectDetail>(`/projects/${enc(id)}/files`, { fileId }),
    removeFile: (id: string, fileId: string) => del<ProjectDetail>(`/projects/${enc(id)}/files/${enc(fileId)}`),
  };

  const memories = {
    list: () => get<Memory[]>("/memories"),
    add: (content: string) => post<Memory>("/memories", { content }),
    update: (id: string, content: string) => patch<Memory>(`/memories/${enc(id)}`, { content }),
    remove: (id: string) => del(`/memories/${enc(id)}`),
    clear: () => del("/memories"),
  };

  const images = {
    list: (q?: PageQuery) => get<Page<GeneratedImage>>("/images", pq(q)),
    create: (body: { prompt: string; aspectRatio?: AspectRatio; sourceImageId?: string }) => post<GeneratedImage>("/images", body),
    remove: (id: string) => del(`/images/${enc(id)}`),
  };

  const shares = {
    create: (conversationId: string, expiresInDays?: number | null) => post<Share>("/shares", { conversationId, expiresInDays }),
    list: () => get<Share[]>("/shares"),
    revoke: (id: string) => del(`/shares/${enc(id)}`),
  };

  /** Public: no account needed. */
  const shared = {
    get: (id: string, signal?: AbortSignal) => http.request<SharedConversation>("GET", `/shared/${enc(id)}`, { signal, noRefresh: true }),
  };

  const speech = {
    /** Dictation: raw audio in, text out. */
    transcribe: (audio: Blob, language?: string) => http.request<{ text: string }>("POST", "/speech/transcribe", { body: audio, query: { language }, headers: { "Content-Type": audio.type || "audio/webm" } }),
  };

  return { models, me, chats, messages, turns, files, projects, memories, images, shares, shared, speech };
}
