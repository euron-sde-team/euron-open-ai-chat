"use client";

/** Reads for the chat app. Writes that touch several caches live in turn-runner.ts and actions.ts. */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ConversationSummary } from "@open-chat/types";
import { api } from "../api";
import { qk } from "../query-keys";

export function useModels() {
  return useQuery({ queryKey: qk.models, queryFn: ({ signal }) => api().models.catalog(signal), staleTime: 60_000 });
}

export function usePreferences() {
  return useQuery({ queryKey: qk.preferences, queryFn: () => api().me.preferences(), staleTime: 60_000 });
}

export function useUsage() {
  return useQuery({ queryKey: qk.usage, queryFn: () => api().me.usage(), staleTime: 15_000, meta: { silent: true } });
}

/** The sidebar list (unpinned, newest first), paged by cursor. */
export function useConversations(filter: { q?: string; projectId?: string } = {}) {
  return useInfiniteQuery({
    queryKey: qk.chats({ ...filter, pinned: false }),
    queryFn: ({ pageParam, signal }) => api().chats.list({ ...filter, pinned: filter.q ? undefined : false, cursor: pageParam, limit: 40 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}

export function usePinned() {
  return useQuery({ queryKey: qk.chats({ pinned: true }), queryFn: ({ signal }) => api().chats.list({ pinned: true, limit: 50 }, signal).then((p) => p.items), staleTime: 15_000 });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: qk.chat(id ?? ""),
    queryFn: ({ signal }) => api().chats.get(id!, signal),
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: () => api().projects.list(), staleTime: 30_000 });
}

export function useProject(id: string) {
  return useQuery({ queryKey: qk.project(id), queryFn: () => api().projects.get(id) });
}

export function useMemories() {
  return useQuery({ queryKey: qk.memories, queryFn: () => api().memories.list() });
}

/** Group conversations under Today, Yesterday, Previous 7 days, Previous 30 days, then months. */
export function groupByDate(items: ConversationSummary[], now = new Date()): { label: string; items: ConversationSummary[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const groups = new Map<string, ConversationSummary[]>();
  for (const c of items) {
    const t = new Date(c.lastMessageAt).getTime();
    let label: string;
    if (t >= startOfToday) label = "Today";
    else if (t >= startOfToday - day) label = "Yesterday";
    else if (t >= startOfToday - 7 * day) label = "Previous 7 days";
    else if (t >= startOfToday - 30 * day) label = "Previous 30 days";
    else label = new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, items: list }));
}
