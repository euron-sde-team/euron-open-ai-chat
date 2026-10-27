"use client";

import Link from "next/link";
import { Avatar, type AvatarSize } from "@open-chat/ui";
import type { UserSummary } from "@open-chat/types";

type AvatarUser = Pick<UserSummary, "id" | "displayName" | "avatarUrl" | "username">;

export function UserAvatar({ user, size = "md", className, href }: { user: AvatarUser; size?: AvatarSize; className?: string; href?: string }) {
  const av = <Avatar name={user.displayName} seed={user.id} src={user.avatarUrl} size={size} className={className} />;
  if (!href) return av;
  return (
    <Link href={href} className="shrink-0 rounded-full focus-visible:ring-2" tabIndex={-1} aria-hidden>
      {av}
    </Link>
  );
}

