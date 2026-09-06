// Task assignee state for Tasks Pro (Tasks has no first-class human assignee).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  formatDispatchCommentPack,
  loadTaskView,
  patchTask,
  postComment,
  TASKS_PLUGIN_ID,
  type TaskRecord,
} from "./tasks-bridge";

const ASSIGNEE_KEY_PREFIX = "assignee:";

const assigneeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("me"),
      assignedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thread"),
      threadId: z.string().startsWith("thr_"),
      title: z.string(),
      assignedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      threadId: z.string().startsWith("thr_"),
      title: z.string(),
      presetName: z.string(),
      assignedAt: z.string(),
    })
    .strict(),
]);

export type TaskAssignee = z.infer<typeof assigneeSchema>;

export type AssignableThread = {
  id: string;
  title: string;
  projectId: string;
  status: string;
  updatedAt: number;
};

const attachOut = z.object({ threadId: z.string().startsWith("thr_") });

function assigneeKey(taskId: string): string {
  return `${ASSIGNEE_KEY_PREFIX}${taskId}`;
}

export async function getAssignee(
  bb: BbPluginApi,
  taskId: string,
): Promise<TaskAssignee | null> {
  const stored = await bb.storage.kv.get<unknown>(assigneeKey(taskId));
  if (stored == null) return null;
  const parsed = assigneeSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export type AssignedToMeRow = {
  taskId: string;
  key: string;
  title: string;
  status: string;
  assignedAt: string;
};

/** Tasks whose Tasks Pro assignee is the human operator (`kind: "me"`). */
export async function listAssignedToMe(
  bb: BbPluginApi,
): Promise<AssignedToMeRow[]> {
  const keys = await bb.storage.kv.list(ASSIGNEE_KEY_PREFIX);
  const rows: AssignedToMeRow[] = [];
  for (const key of keys) {
    if (!key.startsWith(ASSIGNEE_KEY_PREFIX)) continue;
    const taskId = key.slice(ASSIGNEE_KEY_PREFIX.length);
    if (!taskId) continue;
    const assignee = await getAssignee(bb, taskId);
    if (assignee?.kind !== "me") continue;
    const view = await loadTaskView(bb, taskId);
    if (!view) continue;
    if (view.task.status === "done" || view.task.status === "canceled") {
      continue;
    }
    rows.push({
      taskId: view.task.id,
      key: view.task.key,
      title: view.task.title,
      status: view.task.status,
      assignedAt: assignee.assignedAt,
    });
  }
  rows.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  return rows;
}

export async function setAssignee(
  bb: BbPluginApi,
  taskId: string,
  assignee: TaskAssignee | null,
): Promise<void> {
  const key = assigneeKey(taskId);
  if (assignee == null) {
    await bb.storage.kv.delete(key);
    return;
  }
  await bb.storage.kv.set(key, assignee);
}

async function bumpInProgress(bb: BbPluginApi, task: TaskRecord): Promise<TaskRecord> {
  if (task.status !== "backlog" && task.status !== "todo") return task;
  return patchTask(bb, task.id, { status: "in_progress" });
}

function threadLabel(thread: {
  title?: string | null;
  titleFallback?: string | null;
  id: string;
}): string {
  return (thread.title ?? thread.titleFallback ?? thread.id).trim() || thread.id;
}

/** Assign the task to the human operator (stored in Tasks Pro KV). */
export async function assignTaskToMe(
  bb: BbPluginApi,
  taskId: string,
): Promise<{ task: TaskRecord; assignee: TaskAssignee }> {
  const view = await loadTaskView(bb, taskId);
  if (!view) throw new Error("Task not found.");
  let task = await bumpInProgress(bb, view.task);
  const assignee: TaskAssignee = {
    kind: "me",
    assignedAt: new Date().toISOString(),
  };
  await setAssignee(bb, task.id, assignee);
  await postComment(bb, {
    taskId: task.id,
    body: "Assigned to me",
    notify: false,
  });
  // Re-read in case status comment paths changed timestamps.
  const refreshed = await loadTaskView(bb, task.id);
  if (refreshed) task = refreshed.task;
  return { task, assignee };
}

/**
 * Attach an existing bb thread and treat it as the assignee.
 * Sends a short work prompt so the agent actually picks up the task.
 */
export async function assignTaskToThread(
  bb: BbPluginApi,
  input: { taskId: string; threadId: string; notifyThread?: boolean },
): Promise<{ task: TaskRecord; assignee: TaskAssignee; threadId: string }> {
  const view = await loadTaskView(bb, input.taskId);
  if (!view) throw new Error("Task not found.");

  const thread = await bb.sdk.threads.get({ threadId: input.threadId });
  const title = threadLabel(thread);

  await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "taskThreadsAttach",
    input: { taskId: view.task.id, threadId: thread.id },
    outputSchema: attachOut,
  });

  let task = await bumpInProgress(bb, view.task);
  const assignee: TaskAssignee = {
    kind: "thread",
    threadId: thread.id,
    title,
    assignedAt: new Date().toISOString(),
  };
  await setAssignee(bb, task.id, assignee);

  await postComment(bb, {
    taskId: task.id,
    body: `Assigned to existing thread · ${title} (${thread.id})`,
    notify: false,
  });

  if (input.notifyThread !== false) {
    const pack = formatDispatchCommentPack(view.comments);
    const parts = [
      `You are assigned to task ${task.key} — ${task.title}.`,
      "",
      "Use the bb tasks CLI: comment substantive updates, attach result artifacts,",
      `set status when done (\`bb tasks update ${task.key} --status in_review\`),`,
      "or explain blockage in a comment. Your thread is already attached to the task.",
    ];
    if (task.description.trim()) {
      parts.push("", "## Description", "", task.description.trim());
    }
    if (pack) {
      parts.push("", pack);
    }
    await bb.sdk.threads.send({
      threadId: thread.id,
      mode: "auto",
      input: [{ type: "text", text: parts.join("\n"), mentions: [] }],
    });
  }

  const refreshed = await loadTaskView(bb, task.id);
  if (refreshed) task = refreshed.task;
  return { task, assignee, threadId: thread.id };
}

export async function recordAgentAssignee(
  bb: BbPluginApi,
  input: {
    taskId: string;
    threadId: string;
    presetName: string;
    title?: string;
  },
): Promise<TaskAssignee> {
  let title = input.title?.trim() ?? "";
  if (!title) {
    try {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      title = threadLabel(thread);
    } catch {
      title = input.threadId;
    }
  }
  const assignee: TaskAssignee = {
    kind: "agent",
    threadId: input.threadId,
    title,
    presetName: input.presetName,
    assignedAt: new Date().toISOString(),
  };
  await setAssignee(bb, input.taskId, assignee);
  return assignee;
}

/** Recent visible threads the user can attach (prefer linked bb project). */
export async function listAssignableThreads(
  bb: BbPluginApi,
  input: { linkedBbProjectId?: string | null; limit?: number } = {},
): Promise<AssignableThread[]> {
  const limit = input.limit ?? 40;
  const threads = await bb.sdk.threads.list({
    ...(input.linkedBbProjectId
      ? { projectId: input.linkedBbProjectId }
      : {}),
    archived: false,
    includeHidden: false,
    limit: Math.min(Math.max(limit, 1), 100),
  });

  return threads
    .filter(
      (thread) =>
        thread.deletedAt == null && thread.visibility !== "hidden",
    )
    .map((thread) => ({
      id: thread.id,
      title: threadLabel(thread),
      projectId: thread.projectId,
      status: thread.status,
      updatedAt: thread.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
