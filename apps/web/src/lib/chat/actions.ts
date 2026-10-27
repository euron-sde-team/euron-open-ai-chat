"use client";

/** Conversation and project mutations with the cache updates they need. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { ConversationDetail } from "@open-chat/types";
import { toast } from "@open-chat/ui";
import { api } from "../api";
import { qk } from "../query-keys";

export function useChatActions() {
  const qc = useQueryClient();
  const router = useRouter();
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: qk.chatsAll });
    if (id) void qc.invalidateQueries({ queryKey: qk.chat(id) });
  };

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null }) => api().chats.update(id, body),
    onMutate: ({ id, title }) => {
      if (title) qc.setQueryData<ConversationDetail>(qk.chat(id), (d) => (d ? { ...d, title } : d));
    },
    onSuccess: (_r, v) => {
      refresh(v.id);
      if (v.projectId !== undefined) void qc.invalidateQueries({ queryKey: qk.projects });
      if (v.archived) toast.success({ title: "Chat archived" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api().chats.remove(id),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: qk.chat(id) });
      refresh();
      void qc.invalidateQueries({ queryKey: qk.projects });
      if (typeof window !== "undefined" && window.location.pathname === `/c/${id}`) router.push("/");
    },
  });

  return { update, remove };
}

export function useCreateProject() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (body: { name: string; instructions?: string }) => api().projects.create(body),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects });
      router.push(`/projects/${p.id}`);
    },
  });
}
