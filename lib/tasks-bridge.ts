// Read/write Tasks through the sanctioned cross-plugin path.
// Loose schemas: Tasks may add fields; zod strips unknowns.
import { z } from "zod";

export const TASKS_PLUGIN_ID = "tasks";

export interface TasksBridgeApi {
  sdk: {
    plugins: {
      callRpc<TOutput>(args: {
        pluginId: string;
        method: string;
        input?: unknown;
        outputSchema: z.ZodType<TOutput>;
      }): Promise<TOutput>;
    };
  };
}

const TASK_PAGE_LIMIT = 200;
const THREAD_FANOUT_CONCURRENCY = 8;

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number(),
  key: z.string(),
  title: z.string(),
  description: z.string().default(""),
  status: z.string(),
  priority: z.string().default("none"),
  dueDate: z.string().nullable().default(null),
  parentTaskId: z.string().nullable().default(null),
  labelIds: z.array(z.string()).default([]),
  createdAt: z.string().default(""),
  updatedAt: z.string().default(""),
});

const commentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  presetName: z.string().nullable(),
  threadId: z.string().nullable(),
  body: z.string(),
  notifiedCount: z.number(),
  createdAt: z.string(),
  threadTitle: z.string().nullable().optional(),
  provider: z
    .object({
      id: z.string(),
      name: z.string(),
      logoUrl: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

const attachmentSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  commentId: z.string().nullable(),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
  isImage: z.boolean(),
  createdAt: z.string(),
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  color: z.string().default(""),
  folderId: z.string().nullable().optional(),
});

const labelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
});

const taskThreadSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  threadId: z.string(),
  presetName: z.string().default(""),
  title: z.string().default(""),
  liveStatus: z.string().default("idle"),
  attachedAt: z.string().default(""),
});

const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentFolderId: z.string().nullable().optional(),
});

const getTaskByKeyOut = z.object({ task: taskSchema.nullable() });
const getTaskOut = z.object({ task: taskSchema.nullable() });
const listCommentsOut = z.object({ comments: z.array(commentSchema) });
const listAttachmentsOut = z.object({
  attachments: z.array(attachmentSchema),
});
const listTasksOut = z.object({
  tasks: z.array(taskSchema),
  nextCursor: z.string().nullable(),
});
const listProjectsOut = z.object({ projects: z.array(projectSchema) });
const listLabelsOut = z.object({ labels: z.array(labelSchema) });
const listTaskThreadsOut = z.object({
  taskThreads: z.array(taskThreadSchema),
});
const listFoldersOut = z.object({ folders: z.array(folderSchema) });
const createFolderOut = z.object({ folder: folderSchema });
const createProjectOut = z.object({ project: projectSchema });
const createTaskOut = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
const listBbProjectsOut = z.object({
  bbProjects: z.array(
    z.object({ id: z.string().startsWith("proj_"), name: z.string() }),
  ),
});
const createCommentOut = z.object({ comment: commentSchema });
const pullRequestSchema = z.object({
  url: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  updatedAt: z.string().optional(),
  threadIds: z.array(z.string()).default([]),
});
const listTaskPullRequestsOut = z.object({
  pullRequests: z.array(pullRequestSchema),
  unavailableThreadIds: z.array(z.string()).default([]),
});
const updateTaskOut = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type TaskRecord = z.infer<typeof taskSchema>;
export type CommentRecord = z.infer<typeof commentSchema>;
export type AttachmentRecord = z.infer<typeof attachmentSchema>;
export type ProjectRecord = z.infer<typeof projectSchema>;
export type LabelRecord = z.infer<typeof labelSchema>;

export type TaskThreadRecord = z.infer<typeof taskThreadSchema>;
export type FolderRecord = z.infer<typeof folderSchema>;
export type PullRequestRecord = z.infer<typeof pullRequestSchema>;

export type BoardTask = TaskRecord & {
  threadCount: number;
  workingThreadCount: number;
  threadTitles: string[];
  subtaskCount: number;
};

export type TaskView = {
  task: TaskRecord;
  comments: CommentRecord[];
  attachments: AttachmentRecord[];
  labels: LabelRecord[];
  project: ProjectRecord | null;
  threads: TaskThreadRecord[];
  pullRequests: PullRequestRecord[];
  unavailableThreadIds: string[];
};

export type BoardSnapshot = {
  projects: ProjectRecord[];
  folders: FolderRecord[];
  tasks: BoardTask[];
  labels: LabelRecord[];
};

export type TaskPatch = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  labelIds?: string[];
};

function looksLikeTaskId(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value);
}

function isWorkingStatus(status: string): boolean {
  return status === "working" || status === "starting";
}

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function listThreadsForTask(
  bb: TasksBridgeApi,
  taskId: string,
): Promise<TaskThreadRecord[]> {
  try {
    const { taskThreads } = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "listTaskThreads",
      input: { taskId },
      outputSchema: listTaskThreadsOut,
    });
    return taskThreads;
  } catch {
    return [];
  }
}

async function listPullRequestsForTask(
  bb: TasksBridgeApi,
  taskId: string,
): Promise<{ pullRequests: PullRequestRecord[]; unavailableThreadIds: string[] }> {
  try {
    return await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "listTaskPullRequests",
      input: { taskId },
      outputSchema: listTaskPullRequestsOut,
    });
  } catch {
    return { pullRequests: [], unavailableThreadIds: [] };
  }
}

async function listAllTasks(
  bb: TasksBridgeApi,
  extra: {
    search?: string;
    activeOnly?: boolean;
    projectId?: string;
    parentTaskId?: string | null;
  } = {},
): Promise<TaskRecord[]> {
  const tasks: TaskRecord[] = [];
  let cursor: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    tasks.length = 0;
    cursor = undefined;
    try {
      for (;;) {
        const page: z.infer<typeof listTasksOut> = await bb.sdk.plugins.callRpc({
          pluginId: TASKS_PLUGIN_ID,
          method: "listTasks",
          input: {
            limit: TASK_PAGE_LIMIT,
            sort: "manual",
            ...(extra.projectId ? { projectId: extra.projectId } : {}),
            ...(extra.search?.trim() ? { search: extra.search.trim() } : {}),
            ...(extra.activeOnly ? { activeOnly: true } : {}),
            ...(extra.parentTaskId !== undefined
              ? { parentTaskId: extra.parentTaskId }
              : {}),
            ...(cursor ? { cursor } : {}),
          },
          outputSchema: listTasksOut,
        });
        tasks.push(...page.tasks);
        if (!page.nextCursor) return tasks;
        cursor = page.nextCursor;
      }
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return tasks;
}

export async function listProjects(
  bb: TasksBridgeApi,
): Promise<ProjectRecord[]> {
  const { projects } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listProjects",
    input: {},
    outputSchema: listProjectsOut,
  });
  return projects;
}

export async function listFolders(
  bb: TasksBridgeApi,
): Promise<FolderRecord[]> {
  try {
    const { folders } = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "listFolders",
      input: null,
      outputSchema: listFoldersOut,
    });
    return folders;
  } catch {
    return [];
  }
}

export async function createFolder(
  bb: TasksBridgeApi,
  input: { name: string; parentFolderId?: string | null },
): Promise<FolderRecord> {
  const { folder } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "createFolder",
    input: {
      name: input.name.trim(),
      parentFolderId: input.parentFolderId ?? null,
    },
    outputSchema: createFolderOut,
  });
  return folder;
}

export type CreateProjectInput = {
  name: string;
  prefix: string;
  color: string;
  folderId?: string | null;
  linkedBbProjectId?: string | null;
};

export async function createProject(
  bb: TasksBridgeApi,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const { project } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "createProject",
    input: {
      name: input.name.trim(),
      prefix: input.prefix.trim(),
      color: input.color.trim(),
      folderId: input.folderId ?? null,
      linkedBbProjectId: input.linkedBbProjectId ?? null,
    },
    outputSchema: createProjectOut,
  });
  return project;
}

export type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  parentTaskId?: string | null;
  labelIds?: string[];
};

export async function createTask(
  bb: TasksBridgeApi,
  input: CreateTaskInput,
): Promise<TaskRecord> {
  const result = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "createTask",
    input: {
      projectId: input.projectId,
      title: input.title.trim(),
      description: input.description ?? "",
      status: input.status ?? "backlog",
      priority: input.priority ?? "none",
      dueDate: input.dueDate ?? null,
      parentTaskId: input.parentTaskId ?? null,
      labelIds: input.labelIds ?? [],
    },
    outputSchema: createTaskOut,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.task;
}

export async function listBbProjects(
  bb: TasksBridgeApi,
): Promise<{ id: string; name: string }[]> {
  const { bbProjects } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listBbProjects",
    input: null,
    outputSchema: listBbProjectsOut,
  });
  return bbProjects;
}

export async function listLabelsForProject(
  bb: TasksBridgeApi,
  projectId: string,
): Promise<LabelRecord[]> {
  const { labels } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listLabels",
    input: { projectId },
    outputSchema: listLabelsOut,
  });
  return labels;
}

async function listLabelsForProjects(
  bb: TasksBridgeApi,
  projects: ProjectRecord[],
): Promise<LabelRecord[]> {
  const pages = await Promise.all(
    projects.map(async (project) => {
      try {
        return await listLabelsForProject(bb, project.id);
      } catch {
        return [];
      }
    }),
  );
  return pages.flat();
}

export async function loadBoard(
  bb: TasksBridgeApi,
): Promise<BoardSnapshot> {
  const [projects, folders] = await Promise.all([
    listProjects(bb),
    listFolders(bb),
  ]);
  const [tasks, labels] = await Promise.all([
    listAllTasks(bb, {}),
    listLabelsForProjects(bb, projects),
  ]);

  const subtaskCountByParent = new Map<string, number>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    subtaskCountByParent.set(
      task.parentTaskId,
      (subtaskCountByParent.get(task.parentTaskId) ?? 0) + 1,
    );
  }

  // Same as official Tasks list: only top-level rows. Subtasks stay on the parent.
  const topLevel = tasks.filter((task) => task.parentTaskId === null);
  const threadPages = await mapWithConcurrency(
    topLevel,
    THREAD_FANOUT_CONCURRENCY,
    (task) => listThreadsForTask(bb, task.id),
  );

  const boardTasks: BoardTask[] = topLevel.map((task, index) => {
    const threads = threadPages[index] ?? [];
    return {
      ...task,
      threadCount: threads.length,
      workingThreadCount: threads.filter((thread) =>
        isWorkingStatus(thread.liveStatus),
      ).length,
      threadTitles: threads.map((thread) => thread.title).filter(Boolean),
      subtaskCount: subtaskCountByParent.get(task.id) ?? 0,
    };
  });

  return { projects, folders, tasks: boardTasks, labels };
}

/** Same as the Tasks sidebar Active count: every task with a starting/working thread. */
export async function countActiveTasks(bb: TasksBridgeApi): Promise<number> {
  const tasks = await listAllTasks(bb, { activeOnly: true });
  return tasks.length;
}

/** Resolve a key (PRO-1) or task id to a full view. */
export async function loadTaskView(
  bb: TasksBridgeApi,
  keyOrId: string,
): Promise<TaskView | null> {
  const normalized = keyOrId.trim();
  if (!normalized) return null;

  let task: TaskRecord | null = null;
  if (looksLikeTaskId(normalized)) {
    const byId = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "getTask",
      input: { taskId: normalized },
      outputSchema: getTaskOut,
    });
    task = byId.task;
  }
  if (!task) {
    const byKey = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "getTaskByKey",
      input: { taskKey: normalized },
      outputSchema: getTaskByKeyOut,
    });
    task = byKey.task;
  }
  if (!task) return null;

  const projects = await listProjects(bb).catch(() => [] as ProjectRecord[]);
  const project = projects.find((row) => row.id === task.projectId) ?? null;

  const [{ comments }, { attachments }, labels, threads, pullRequestView] =
    await Promise.all([
    bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "listComments",
      input: { taskId: task.id },
      outputSchema: listCommentsOut,
    }),
    bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method: "listAttachments",
      input: { taskId: task.id },
      outputSchema: listAttachmentsOut,
    }),
    listLabelsForProject(bb, task.projectId).catch(() => [] as LabelRecord[]),
    listThreadsForTask(bb, task.id),
    listPullRequestsForTask(bb, task.id),
  ]);

  return {
    task,
    comments,
    attachments,
    labels,
    project,
    threads,
    pullRequests: pullRequestView.pullRequests,
    unavailableThreadIds: pullRequestView.unavailableThreadIds,
  };
}

export async function searchTasks(
  bb: TasksBridgeApi,
  search: string,
  limit = 40,
): Promise<TaskRecord[]> {
  const page = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listTasks",
    input: {
      limit,
      sort: "manual",
      ...(search.trim() ? { search: search.trim() } : { activeOnly: true }),
    },
    outputSchema: listTasksOut,
  });
  return page.tasks;
}

export async function postComment(
  bb: TasksBridgeApi,
  input: { taskId: string; body: string; notify: boolean },
): Promise<CommentRecord> {
  const { comment } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "createComment",
    input: {
      taskId: input.taskId,
      body: input.body,
      notify: input.notify,
    },
    outputSchema: createCommentOut,
  });
  return comment;
}

export async function patchTask(
  bb: TasksBridgeApi,
  taskId: string,
  patch: TaskPatch,
): Promise<TaskRecord> {
  const result = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "updateTask",
    input: { taskId, ...patch },
    outputSchema: updateTaskOut,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.task;
}

const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  reasoningLevel: z.string().optional().default("medium"),
  permissionMode: z.string().optional().default("auto"),
  environmentKind: z.string().optional().default("project-default"),
  baseBranch: z.string().nullable().optional().default(null),
  machineId: z.string().nullable().optional().default(null),
  instructions: z.string().optional().default(""),
  builtin: z.boolean().optional().default(false),
});

const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  supportedPermissionModes: z.array(z.string()).optional().default([]),
});

const providerModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean().optional().default(false),
});

const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const listPresetsOut = z.object({ presets: z.array(presetSchema) });
const listProvidersOut = z.object({ providers: z.array(providerSchema) });
const listProviderModelsOut = z.object({
  models: z.array(providerModelSchema),
  reasoningLevels: z.array(z.string()).optional().default([]),
});
const listMachinesOut = z.object({ machines: z.array(machineSchema) });
const presetMutationOut = z.object({ preset: presetSchema });
const delegateOut = z.object({ threadId: z.string() });

export type PresetRecord = z.infer<typeof presetSchema>;
export type ProviderRecord = z.infer<typeof providerSchema>;
export type ProviderModelRecord = z.infer<typeof providerModelSchema>;
export type MachineRecord = z.infer<typeof machineSchema>;

export type PresetWriteInput = {
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  permissionMode: string;
  environmentKind: string;
  baseBranch?: string | null;
  machineId?: string | null;
  instructions?: string;
};

function toTasksPresetFields(input: PresetWriteInput) {
  const worktree = input.environmentKind === "new-worktree";
  const baseBranch = input.baseBranch?.trim() ?? "";
  const machineId = input.machineId?.trim() ?? "";
  return {
    name: input.name.trim(),
    providerId: input.providerId.trim(),
    modelId: input.modelId.trim(),
    reasoningLevel: input.reasoningLevel,
    permissionMode: input.permissionMode,
    environmentKind: input.environmentKind,
    baseBranch: worktree && baseBranch !== "" ? baseBranch : null,
    machineId: worktree && machineId !== "" ? machineId : null,
    instructions: input.instructions ?? "",
  };
}

export async function listPresets(
  bb: TasksBridgeApi,
): Promise<PresetRecord[]> {
  const { presets } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listPresets",
    input: null,
    outputSchema: listPresetsOut,
  });
  return presets;
}

export async function listProviders(
  bb: TasksBridgeApi,
): Promise<ProviderRecord[]> {
  const { providers } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listProviders",
    input: {},
    outputSchema: listProvidersOut,
  });
  return providers;
}

export async function listProviderModels(
  bb: TasksBridgeApi,
  providerId: string,
): Promise<{ models: ProviderModelRecord[]; reasoningLevels: string[] }> {
  return bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listProviderModels",
    input: { providerId },
    outputSchema: listProviderModelsOut,
  });
}

export async function listMachines(
  bb: TasksBridgeApi,
): Promise<MachineRecord[]> {
  const { machines } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listMachines",
    input: {},
    outputSchema: listMachinesOut,
  });
  return machines;
}

export async function createPreset(
  bb: TasksBridgeApi,
  input: PresetWriteInput,
): Promise<PresetRecord> {
  const { preset } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "createPreset",
    input: toTasksPresetFields(input),
    outputSchema: presetMutationOut,
  });
  return preset;
}

export async function updatePreset(
  bb: TasksBridgeApi,
  presetId: string,
  input: PresetWriteInput,
): Promise<PresetRecord> {
  const { preset } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "updatePreset",
    input: { presetId, ...toTasksPresetFields(input) },
    outputSchema: presetMutationOut,
  });
  return preset;
}

/**
 * Tasks' seed prompt only keeps `comments.slice(-5)`, including system
 * status rows. That crowds out earlier user/agent notes on redispatches
 * (see MUR-19 / TP-7). Tasks Pro cannot change Tasks' seed builder, so
 * we pass a filtered pack through `extraInstructions`.
 */
const DISPATCH_COMMENT_LIMIT = 20;
const DISPATCH_COMMENT_CHAR_BUDGET = 14_000;

/** User + agent comments only, newest last, capped by count and chars. */
export function formatDispatchCommentPack(
  comments: CommentRecord[],
): string {
  const useful = comments
    .filter((comment) => comment.kind !== "system" && comment.body.trim())
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (useful.length === 0) return "";

  let selected = useful.slice(-DISPATCH_COMMENT_LIMIT);
  const formatOne = (comment: CommentRecord) =>
    `### ${comment.authorName} · ${comment.kind} · ${comment.createdAt}\n\n${comment.body.trim()}`;

  while (selected.length > 1) {
    const body = selected.map(formatOne).join("\n\n");
    if (body.length <= DISPATCH_COMMENT_CHAR_BUDGET) break;
    selected = selected.slice(1);
  }

  const body = selected.map(formatOne).join("\n\n");
  const omitted = useful.length - selected.length;
  const omissionNote =
    omitted > 0
      ? `\n\n_(${omitted} older user/agent comment${omitted === 1 ? "" : "s"} omitted for size.)_`
      : "";

  return `## Task comments (user + agent)

Tasks' built-in **Recent comments** window keeps only the last 5 rows and includes system status changes. Prefer this filtered pack for prior context.

${body}${omissionNote}`;
}

function mergeExtraInstructions(
  pack: string,
  caller?: string,
): string | undefined {
  const parts = [pack.trim(), caller?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

/** Same as `bb tasks dispatch`, plus a filtered user/agent comment pack. */
export async function dispatchTask(
  bb: TasksBridgeApi,
  input: { taskId: string; presetId: string; extraInstructions?: string },
): Promise<string> {
  const { comments } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "listComments",
    input: { taskId: input.taskId },
    outputSchema: listCommentsOut,
  });
  const extraInstructions = mergeExtraInstructions(
    formatDispatchCommentPack(comments),
    input.extraInstructions,
  );

  const { threadId } = await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "delegate",
    input: {
      taskId: input.taskId,
      presetId: input.presetId,
      ...(extraInstructions ? { extraInstructions } : {}),
    },
    outputSchema: delegateOut,
  });
  return threadId;
}

export function tasksUnavailableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|disabled|not installed|unavailable/i.test(message)) {
    return "Tasks plugin is unavailable. Install/enable it with `bb plugin install tasks`.";
  }
  return message;
}
