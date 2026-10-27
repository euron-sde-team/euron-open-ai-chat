import type { Metadata } from "next";
import { SharedView } from "@/components/chat/shared-view";

export const metadata: Metadata = { title: "Shared chat", robots: { index: false, follow: false } };

export default async function SharedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharedView id={id} />;
}
