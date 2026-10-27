import { ProjectView } from "@/components/chat/project-view";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectView key={id} projectId={id} />;
}
