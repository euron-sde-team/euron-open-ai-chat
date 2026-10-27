import type { Metadata } from "next";
import { ImagesView } from "@/components/chat/images-view";

export const metadata: Metadata = { title: "Images" };

export default function ImagesPage() {
  return <ImagesView />;
}
