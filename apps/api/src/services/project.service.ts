/** Projects: a named group of chats with shared instructions and knowledge files the assistant can search. */
import type { Project, ProjectDetail } from "@open-chat/types";
import { sql } from "kysely";
import { type Actor, requireActive } from "../core/context";
import { badRequest, conflict, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { db } from "../db/kysely";
import { loadFiles } from "../presenters/file.presenter";
import { ownFile } from "./file.service";

export const MAX_PROJECTS = 100;
export const MAX_PROJECT_FILES = 50;

type Row = { id: string; name: string; instructions: string; created_at: Date; updated_at: Date; file_count: number | string; chat_count: number | string };

function toProject(r: Row): Project {
  return { id: r.id, name: r.name, instructions: r.instructions, fileCount: Number(r.file_count), chatCount: Number(r.chat_count), createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
}

function base() {
  return db
    .selectFrom("projects as p")
    .select(["p.id", "p.name", "p.instructions", "p.created_at", "p.updated_at"])
    .select(sql<number>`(SELECT count(*) FROM project_files pf JOIN files f ON f.id = pf.file_id WHERE pf.project_id = p.id AND f.status <> 'DELETED')`.as("file_count"))
    .select(sql<number>`(SELECT count(*) FROM conversations c WHERE c.project_id = p.id)`.as("chat_count"));
}

export async function listProjects(actor: Actor): Promise<Project[]> {
  const rows = await base().where("p.user_id", "=", actor.id).orderBy("p.updated_at", "desc").limit(MAX_PROJECTS).execute();
  return rows.map(toProject);
}

async function own(actor: Actor, id: string): Promise<Row> {
  const r = await base().where("p.id", "=", id).where("p.user_id", "=", actor.id).executeTakeFirst();
  if (!r) throw notFound("Project not found", "PROJECT_NOT_FOUND");
  return r;
}

export async function getProject(actor: Actor, id: string): Promise<ProjectDetail> {
  const r = await own(actor, id);
  const links = await db.selectFrom("project_files").select("file_id").where("project_id", "=", id).orderBy("added_at").execute();
  const files = await loadFiles(links.map((l) => l.file_id));
  return { ...toProject(r), files: links.map((l) => files.get(l.file_id)).filter((f): f is NonNullable<typeof f> => !!f) };
}

export async function createProject(actor: Actor, input: { name: string; instructions?: string }): Promise<ProjectDetail> {
  requireActive(actor);
  const count = await db.selectFrom("projects").select((eb) => eb.fn.countAll<string>().as("n")).where("user_id", "=", actor.id).executeTakeFirstOrThrow();
  if (Number(count.n) >= MAX_PROJECTS) throw conflict(`You can have at most ${MAX_PROJECTS} projects`, "PROJECT_LIMIT");
  const id = newId();
  await db.insertInto("projects").values({ id, user_id: actor.id, name: input.name.trim(), instructions: input.instructions?.trim() ?? "" }).execute();
  return getProject(actor, id);
}

export async function updateProject(actor: Actor, id: string, patch: { name?: string; instructions?: string }): Promise<ProjectDetail> {
  requireActive(actor);
  await own(actor, id);
  await db
    .updateTable("projects")
    .set({ ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.instructions !== undefined ? { instructions: patch.instructions.trim() } : {}), updated_at: new Date() })
    .where("id", "=", id)
    .execute();
  return getProject(actor, id);
}

/** Delete a project. Its chats stay (moved out of the project); its knowledge files are released. */
export async function deleteProject(actor: Actor, id: string): Promise<void> {
  await own(actor, id);
  await db.transaction().execute(async (trx) => {
    const files = await trx.selectFrom("project_files").select("file_id").where("project_id", "=", id).execute();
    await trx.deleteFrom("projects").where("id", "=", id).execute();
    if (files.length) await trx.updateTable("files").set({ status: "DELETED", extracted_text: null }).where("id", "in", files.map((f) => f.file_id)).where("purpose", "=", "PROJECT").where("owner_id", "=", actor.id).execute();
  });
}

export async function addProjectFile(actor: Actor, projectId: string, fileId: string): Promise<ProjectDetail> {
  requireActive(actor);
  const p = await own(actor, projectId);
  const f = await ownFile(actor, fileId);
  if (f.purpose !== "PROJECT") throw badRequest("Upload the file as project knowledge", "FILE_PURPOSE_MISMATCH");
  if (Number(p.file_count) >= MAX_PROJECT_FILES) throw conflict(`A project can hold at most ${MAX_PROJECT_FILES} files`, "PROJECT_FILE_LIMIT");
  await db.insertInto("project_files").values({ project_id: projectId, file_id: fileId }).onConflict((oc) => oc.doNothing()).execute();
  await db.updateTable("projects").set({ updated_at: new Date() }).where("id", "=", projectId).execute();
  return getProject(actor, projectId);
}

export async function removeProjectFile(actor: Actor, projectId: string, fileId: string): Promise<ProjectDetail> {
  await own(actor, projectId);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("project_files").where("project_id", "=", projectId).where("file_id", "=", fileId).execute();
    await trx.updateTable("files").set({ status: "DELETED", extracted_text: null }).where("id", "=", fileId).where("owner_id", "=", actor.id).where("purpose", "=", "PROJECT").execute();
  });
  return getProject(actor, projectId);
}
