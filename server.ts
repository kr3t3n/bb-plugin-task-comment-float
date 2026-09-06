// Tasks Pro — companion to the official Tasks plugin.
// Never forks Tasks UI — reads/writes only via bb.sdk.plugins.callRpc("tasks", …).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_PRESET_NAME,
  PRESET_ENVIRONMENT_KINDS,
  PRESET_PERMISSION_MODES,
  PRESET_REASONING_LEVELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "./lib/model";
import {
  isTaskSort,
  labelFilterOptions,
  matchesFilters,
  selectedLabelIds,
  sortTasks,
  type ListFilters,
} from "./lib/list-preference";
import {
  assignTaskToMe,
  assignTaskToThread,
  getAssignee,
  listAssignableThreads as fetchAssignableThreads,
  listAssignedToMe,
  recordAgentAssignee,
  type TaskAssignee,
} from "./lib/assignee";
import {
  loadBoard,
  loadTaskView,
  countActiveTasks,
  findTaskForThread,
  createFolder as createTaskFolder,
  createPreset as createTaskPreset,
  createProject as createTaskProject,
  createTask as createNewTask,
  dispatchTask as spawnTaskAgent,
  listBbProjects as fetchBbProjects,
  listMachines as fetchTaskMachines,
  listPresets as fetchTaskPresets,
  listProviderModels as fetchTaskProviderModels,
  listProviders as fetchTaskProviders,
  patchTask,
  postComment,
  tasksUnavailableMessage,
  updatePreset as updateTaskPreset,
  type PresetRecord,
} from "./lib/tasks-bridge";
import {
  deleteEnvProfile as removeEnvProfile,
  envTargetSchema,
  EnvTargetError,
  findEnvProfile,
  listEnvProfiles as fetchEnvProfiles,
  listEnvironmentOptions,
  resolveEnvTarget,
  saveEnvProfile as writeEnvProfile,
  type EnvTarget,
} from "./lib/env-target";
import { dispatchTaskToEnvironment } from "./lib/env-dispatch";

const taskOut = z.object({
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
  threadCount: z.number().int().nonnegative().default(0),
  workingThreadCount: z.number().int().nonnegative().default(0),
  threadTitles: z.array(z.string()).default([]),
  subtaskCount: z.number().int().nonnegative().default(0),
});

const threadOut = z.object({
  id: z.string(),
  taskId: z.string(),
  threadId: z.string(),
  presetName: z.string().default(""),
  title: z.string().default(""),
  liveStatus: z.string().default("idle"),
  attachedAt: z.string().default(""),
});

const commentOut = z.object({
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
});

const attachmentOut = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  commentId: z.string().nullable(),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
  isImage: z.boolean(),
  createdAt: z.string(),
});

const projectOut = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  color: z.string().default(""),
  folderId: z.string().nullable().optional(),
  linkedBbProjectId: z.string().startsWith("proj_").nullable().optional(),
});

const assigneeOut = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("me"),
      assignedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thread"),
      threadId: z.string(),
      title: z.string(),
      assignedAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      threadId: z.string(),
      title: z.string(),
      presetName: z.string(),
      assignedAt: z.string(),
    })
    .strict(),
]);

const assignableThreadOut = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  status: z.string(),
  updatedAt: z.number(),
});

const folderOut = z.object({
  id: z.string(),
  name: z.string(),
  parentFolderId: z.string().nullable().optional(),
});

const labelOut = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
});

const pullRequestOut = z.object({
  url: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  threadIds: z.array(z.string()).default([]),
});

const presetOut = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  reasoningLevel: z.string().optional(),
  permissionMode: z.string().optional(),
  environmentKind: z.string().optional(),
  baseBranch: z.string().nullable().optional(),
  machineId: z.string().nullable().optional(),
  instructions: z.string().optional(),
  builtin: z.boolean().optional(),
});

const presetWriteFields = z
  .object({
    name: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    reasoningLevel: z.enum(PRESET_REASONING_LEVELS),
    permissionMode: z.enum(PRESET_PERMISSION_MODES),
    environmentKind: z.enum(PRESET_ENVIRONMENT_KINDS),
    baseBranch: z.string().nullable().optional(),
    machineId: z.string().nullable().optional(),
    instructions: z.string().optional(),
  })
  .strict();

const emptyView = {
  available: false as const,
  error: null as string | null,
  task: null,
  comments: [] as z.infer<typeof commentOut>[],
  attachments: [] as z.infer<typeof attachmentOut>[],
  labels: [] as z.infer<typeof labelOut>[],
  project: null,
  threads: [] as z.infer<typeof threadOut>[],
  pullRequests: [] as z.infer<typeof pullRequestOut>[],
  unavailableThreadIds: [] as string[],
  assignee: null as TaskAssignee | null,
};

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        values.push(next);
        i += 1;
      }
    }
  }
  return values;
}

const envProfileOut = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["reuse", "path"]),
    environmentId: z.string().nullable(),
    path: z.string().nullable(),
    branch: z.string().nullable(),
    hostId: z.string().nullable(),
    bbProjectId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const environmentOptionOut = z
  .object({
    id: z.string(),
    name: z.string(),
    path: z.string().nullable(),
    projectId: z.string(),
    hostId: z.string(),
    branchName: z.string().nullable(),
    status: z.string(),
    workspaceProvisionType: z.string(),
    isWorktree: z.boolean(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getView: {
    input: z.object({ keyOrId: z.string().min(1) }).strict(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        task: taskOut.nullable(),
        comments: z.array(commentOut),
        attachments: z.array(attachmentOut),
        labels: z.array(labelOut),
        project: projectOut.nullable(),
        threads: z.array(threadOut),
        pullRequests: z.array(pullRequestOut),
        unavailableThreadIds: z.array(z.string()),
        assignee: assigneeOut.nullable(),
      })
      .strict(),
  },
  listBoard: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        projects: z.array(projectOut),
        folders: z.array(folderOut),
        tasks: z.array(taskOut),
        labels: z.array(labelOut),
      })
      .strict(),
  },
  postComment: {
    input: z
      .object({
        taskId: z.string().min(1),
        body: z.string(),
        notify: z.boolean().default(false),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        comment: commentOut.nullable(),
      })
      .strict(),
  },
  updateTask: {
    input: z
      .object({
        taskId: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        dueDate: z.string().nullable().optional(),
        labelIds: z.array(z.string()).optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        task: taskOut.nullable(),
      })
      .strict(),
  },
  listPresets: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        presets: z.array(presetOut),
      })
      .strict(),
  },
  listProviders: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        providers: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            supportedPermissionModes: z.array(z.string()),
          }),
        ),
      })
      .strict(),
  },
  listProviderModels: {
    input: z.object({ providerId: z.string().min(1) }).strict(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        models: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            isDefault: z.boolean(),
          }),
        ),
        reasoningLevels: z.array(z.string()),
      })
      .strict(),
  },
  listMachines: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        machines: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
          }),
        ),
      })
      .strict(),
  },
  createPreset: {
    input: presetWriteFields,
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        preset: presetOut.nullable(),
      })
      .strict(),
  },
  updatePreset: {
    input: presetWriteFields.extend({ presetId: z.string().min(1) }),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        preset: presetOut.nullable(),
      })
      .strict(),
  },
  dispatch: {
    input: z
      .object({
        taskId: z.string().min(1),
        presetId: z.string().min(1),
        extraInstructions: z.string().optional(),
        // TPRO-3: omit (or use kind "preset") to keep the Tasks delegate path.
        envTarget: envTargetSchema.optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        threadId: z.string().nullable(),
        via: z.enum(["delegate", "spawn"]).nullable(),
        environmentId: z.string().nullable(),
      })
      .strict(),
  },
  listEnvProfiles: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        profiles: z.array(envProfileOut),
      })
      .strict(),
  },
  saveEnvProfile: {
    input: z
      .object({
        id: z.string().min(1).optional(),
        name: z.string().min(1),
        kind: z.enum(["reuse", "path"]),
        environmentId: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
        branch: z.string().nullable().optional(),
        hostId: z.string().nullable().optional(),
        bbProjectId: z.string().nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        profile: envProfileOut.nullable(),
      })
      .strict(),
  },
  deleteEnvProfile: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({ ok: z.boolean(), error: z.string().nullable() })
      .strict(),
  },
  listEnvironments: {
    input: z.object({ bbProjectId: z.string().optional() }).strict(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        environments: z.array(environmentOptionOut),
      })
      .strict(),
  },
  assignToMe: {
    input: z.object({ taskId: z.string().min(1) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        assignee: assigneeOut.nullable(),
        task: taskOut.nullable(),
      })
      .strict(),
  },
  listAssignedToMe: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        tasks: z.array(
          z
            .object({
              taskId: z.string(),
              key: z.string(),
              title: z.string(),
              status: z.string(),
              assignedAt: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  assignToThread: {
    input: z
      .object({
        taskId: z.string().min(1),
        threadId: z.string().startsWith("thr_"),
        notifyThread: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        assignee: assigneeOut.nullable(),
        threadId: z.string().nullable(),
        task: taskOut.nullable(),
      })
      .strict(),
  },
  listAssignableThreads: {
    input: z
      .object({
        linkedBbProjectId: z
          .string()
          .startsWith("proj_")
          .nullable()
          .optional(),
        limit: z.number().int().positive().max(100).optional(),
      })
      .strict(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        threads: z.array(assignableThreadOut),
      })
      .strict(),
  },
  activeCount: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        count: z.number().int().nonnegative(),
      })
      .strict(),
  },
  resolveThreadTask: {
    input: z
      .object({
        threadId: z.string().startsWith("thr_"),
      })
      .strict(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        taskKey: z.string().nullable(),
        taskId: z.string().nullable(),
      })
      .strict(),
  },
  listBbProjects: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        error: z.string().nullable(),
        bbProjects: z.array(
          z.object({ id: z.string().startsWith("proj_"), name: z.string() }),
        ),
      })
      .strict(),
  },
  createFolder: {
    input: z
      .object({
        name: z.string().trim().min(1),
        parentFolderId: z.string().nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        folder: folderOut.nullable(),
      })
      .strict(),
  },
  createProject: {
    input: z
      .object({
        name: z.string().trim().min(1),
        prefix: z.string().trim().min(1),
        color: z.string().trim().min(1),
        folderId: z.string().nullable().optional(),
        linkedBbProjectId: z.string().startsWith("proj_").nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        project: projectOut.nullable(),
      })
      .strict(),
  },
  createTask: {
    input: z
      .object({
        projectId: z.string().min(1),
        title: z.string().trim().min(1),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        dueDate: z.string().nullable().optional(),
        parentTaskId: z.string().nullable().optional(),
        labelIds: z.array(z.string()).optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().nullable(),
        task: taskOut.nullable(),
      })
      .strict(),
  },
});

const DISPATCH_USAGE =
  "Usage: bb tasks-pro dispatch <key-or-id> [--preset <name>] [--env-id <id> | --path <abs> [--branch <name>] [--host-id <id>] | --profile <name>] [--instructions <text>] [--json]";

const ENV_PROFILE_SET_USAGE =
  "Usage: bb tasks-pro env-profile-set <name> (--env-id <id> | --path <abs> [--branch <name>] [--host-id <id>]) [--project <proj_id>] [--json]";

/**
 * Turn the CLI environment flags into the shared `envTarget` wire shape.
 * Returns undefined when no flag is set, which keeps the Tasks delegate path.
 */
function buildCliEnvTarget(flags: {
  envId?: string;
  path?: string;
  branch?: string;
  profile?: string;
  hostId?: string;
}): EnvTarget | undefined {
  const envId = flags.envId?.trim();
  const path = flags.path?.trim();
  const profile = flags.profile?.trim();
  const branch = flags.branch?.trim();
  const hostId = flags.hostId?.trim();
  const chosen = [envId, path, profile].filter(Boolean).length;
  const pathOnly = () => {
    if (branch) throw new EnvTargetError("--branch only applies with --path.");
    if (hostId) throw new EnvTargetError("--host-id only applies with --path.");
  };

  if (chosen === 0) {
    pathOnly();
    return undefined;
  }
  if (chosen > 1) {
    throw new EnvTargetError(
      "Pass at most one of --env-id, --path, or --profile.",
    );
  }
  if (envId) {
    pathOnly();
    return { kind: "reuse", environmentId: envId };
  }
  if (path) {
    return {
      kind: "path",
      path,
      ...(branch ? { branch } : {}),
      ...(hostId ? { hostId } : {}),
    };
  }
  pathOnly();
  return { kind: "profile", profileId: profile };
}

/** Env-target problems are user input errors; Tasks outages need their own hint. */
function dispatchErrorMessage(error: unknown): string {
  if (error instanceof EnvTargetError) return error.message;
  return tasksUnavailableMessage(error);
}

type DispatchOutcome = {
  threadId: string;
  via: "delegate" | "spawn";
  environmentId: string | null;
};

/**
 * One dispatch path for the RPC and the CLI.
 *
 * No `envTarget` (or kind "preset") keeps the exact behaviour Tasks Pro shipped
 * before TPRO-3: call Tasks `delegate` and let the preset's `environmentKind`
 * pick the environment. An explicit `reuse` or `path` target spawns the thread
 * here instead, because `delegate` cannot express either one.
 */
async function runDispatch(
  bb: BbPluginApi,
  input: {
    taskId: string;
    presetId: string;
    extraInstructions?: string;
    envTarget?: EnvTarget;
    preset?: PresetRecord;
  },
): Promise<DispatchOutcome> {
  const resolved = await resolveEnvTarget(bb, input.envTarget);

  if (resolved.kind === "preset") {
    const threadId = await spawnTaskAgent(bb, {
      taskId: input.taskId,
      presetId: input.presetId,
      extraInstructions: input.extraInstructions,
    });
    if (input.preset) {
      await recordAgentAssignee(bb, {
        taskId: input.taskId,
        threadId,
        presetName: input.preset.name,
      });
    }
    return { threadId, via: "delegate", environmentId: null };
  }

  const preset = input.preset;
  if (!preset) {
    throw new EnvTargetError(
      `No preset ${input.presetId}. An explicit environment target needs a resolvable preset.`,
    );
  }

  const result = await dispatchTaskToEnvironment(bb, {
    taskId: input.taskId,
    preset,
    target: resolved,
    extraInstructions: input.extraInstructions,
  });
  await recordAgentAssignee(bb, {
    taskId: input.taskId,
    threadId: result.threadId,
    presetName: preset.name,
  });
  return {
    threadId: result.threadId,
    via: "spawn",
    environmentId: result.environmentId,
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("tasks-pro loaded (companion to Tasks)");

  async function getViewHandler(input: { keyOrId: string }) {
    try {
      const view = await loadTaskView(bb, input.keyOrId);
      if (!view) {
        return {
          ...emptyView,
          available: true,
          error: `No task found for “${input.keyOrId.trim()}”.`,
        };
      }
      const assignee = await getAssignee(bb, view.task.id);
      return {
        available: true,
        error: null,
        task: view.task,
        comments: view.comments,
        attachments: view.attachments,
        labels: view.labels,
        project: view.project,
        threads: view.threads,
        pullRequests: view.pullRequests,
        unavailableThreadIds: view.unavailableThreadIds,
        assignee,
      };
    } catch (error) {
      return {
        ...emptyView,
        available: false,
        error: tasksUnavailableMessage(error),
      };
    }
  }

  async function postCommentHandler(input: {
    taskId: string;
    body: string;
    notify: boolean;
  }) {
    const body = input.body.trim();
    if (!body) {
      return { ok: false, error: "Comment body cannot be empty.", comment: null };
    }
    try {
      const comment = await postComment(bb, {
        taskId: input.taskId,
        body,
        notify: input.notify,
      });
      return { ok: true, error: null, comment };
    } catch (error) {
      return {
        ok: false,
        error: tasksUnavailableMessage(error),
        comment: null,
      };
    }
  }

  bb.rpc.register(rpcContract, {
    getView: getViewHandler,
    async listBoard() {
      try {
        const board = await loadBoard(bb);
        bb.log.info(
          `listBoard: ${board.tasks.length} tasks, ${board.projects.length} projects`,
        );
        return {
          available: true,
          error: null,
          projects: board.projects,
          folders: board.folders,
          tasks: board.tasks,
          labels: board.labels,
        };
      } catch (error) {
        bb.log.warn(`listBoard failed: ${tasksUnavailableMessage(error)}`);
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          projects: [],
          folders: [],
          tasks: [],
          labels: [],
        };
      }
    },
    postComment: postCommentHandler,
    async listPresets() {
      try {
        const presets = await fetchTaskPresets(bb);
        return { available: true, error: null, presets };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          presets: [],
        };
      }
    },
    async listProviders() {
      try {
        const providers = await fetchTaskProviders(bb);
        return { available: true, error: null, providers };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          providers: [],
        };
      }
    },
    async listProviderModels(input) {
      try {
        const result = await fetchTaskProviderModels(bb, input.providerId);
        return {
          available: true,
          error: null,
          models: result.models,
          reasoningLevels: result.reasoningLevels,
        };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          models: [],
          reasoningLevels: [],
        };
      }
    },
    async listMachines() {
      try {
        const machines = await fetchTaskMachines(bb);
        return { available: true, error: null, machines };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          machines: [],
        };
      }
    },
    async createPreset(input) {
      try {
        const preset = await createTaskPreset(bb, input);
        return { ok: true, error: null, preset };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          preset: null,
        };
      }
    },
    async updatePreset(input) {
      try {
        const { presetId, ...fields } = input;
        const preset = await updateTaskPreset(bb, presetId, fields);
        return { ok: true, error: null, preset };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          preset: null,
        };
      }
    },
    async dispatch(input) {
      try {
        const { envTarget, ...delegateInput } = input;
        const presets = await fetchTaskPresets(bb);
        const preset = presets.find((item) => item.id === input.presetId);
        const result = await runDispatch(bb, {
          taskId: delegateInput.taskId,
          presetId: delegateInput.presetId,
          extraInstructions: delegateInput.extraInstructions,
          envTarget,
          preset,
        });
        bb.realtime.publish("active-count", { threadId: result.threadId });
        return {
          ok: true,
          error: null,
          threadId: result.threadId,
          via: result.via,
          environmentId: result.environmentId,
        };
      } catch (error) {
        return {
          ok: false,
          error: dispatchErrorMessage(error),
          threadId: null,
          via: null,
          environmentId: null,
        };
      }
    },
    async listEnvProfiles() {
      try {
        const profiles = await fetchEnvProfiles(bb);
        return { available: true, error: null, profiles };
      } catch (error) {
        return {
          available: false,
          error: dispatchErrorMessage(error),
          profiles: [],
        };
      }
    },
    async saveEnvProfile(input) {
      try {
        const profile = await writeEnvProfile(bb, input);
        return { ok: true, error: null, profile };
      } catch (error) {
        return {
          ok: false,
          error: dispatchErrorMessage(error),
          profile: null,
        };
      }
    },
    async deleteEnvProfile(input) {
      try {
        const removed = await removeEnvProfile(bb, input.id);
        if (!removed) {
          return { ok: false, error: `No env profile ${input.id}.` };
        }
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: dispatchErrorMessage(error) };
      }
    },
    async listEnvironments(input) {
      try {
        const environments = await listEnvironmentOptions(bb, {
          bbProjectId: input.bbProjectId ?? null,
        });
        return { available: true, error: null, environments };
      } catch (error) {
        return {
          available: false,
          error: dispatchErrorMessage(error),
          environments: [],
        };
      }
    },
    async assignToMe(input) {
      try {
        const result = await assignTaskToMe(bb, input.taskId);
        bb.realtime.publish("assignee", {
          type: "assigned-to-me",
          taskId: result.task.id,
          key: result.task.key,
          title: result.task.title,
          status: result.task.status,
          assignedAt: result.assignee.assignedAt,
        });
        return {
          ok: true,
          error: null,
          assignee: result.assignee,
          task: result.task,
        };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          assignee: null,
          task: null,
        };
      }
    },
    async listAssignedToMe() {
      try {
        const tasks = await listAssignedToMe(bb);
        return { available: true, error: null, tasks };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          tasks: [],
        };
      }
    },
    async assignToThread(input) {
      try {
        const result = await assignTaskToThread(bb, input);
        bb.realtime.publish("active-count", { threadId: result.threadId });
        bb.realtime.publish("assignee", {
          type: "assigned-to-thread",
          taskId: result.task.id,
          key: result.task.key,
          threadId: result.threadId,
        });
        return {
          ok: true,
          error: null,
          assignee: result.assignee,
          threadId: result.threadId,
          task: result.task,
        };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          assignee: null,
          threadId: null,
          task: null,
        };
      }
    },
    async listAssignableThreads(input) {
      try {
        const threads = await fetchAssignableThreads(bb, input);
        return { available: true, error: null, threads };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          threads: [],
        };
      }
    },
    async activeCount() {
      try {
        const count = await countActiveTasks(bb);
        return { available: true, error: null, count };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          count: 0,
        };
      }
    },
    async resolveThreadTask(input: { threadId: string }) {
      try {
        const hit = await findTaskForThread(bb, input.threadId);
        return {
          available: true,
          error: null,
          taskKey: hit?.taskKey ?? null,
          taskId: hit?.taskId ?? null,
        };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          taskKey: null,
          taskId: null,
        };
      }
    },
    async listBbProjects() {
      try {
        const bbProjects = await fetchBbProjects(bb);
        return { available: true, error: null, bbProjects };
      } catch (error) {
        return {
          available: false,
          error: tasksUnavailableMessage(error),
          bbProjects: [],
        };
      }
    },
    async createFolder(input) {
      try {
        const folder = await createTaskFolder(bb, input);
        return { ok: true, error: null, folder };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          folder: null,
        };
      }
    },
    async createProject(input) {
      try {
        const project = await createTaskProject(bb, input);
        return { ok: true, error: null, project };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          project: null,
        };
      }
    },
    async createTask(input) {
      try {
        const task = await createNewTask(bb, input);
        return { ok: true, error: null, task };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          task: null,
        };
      }
    },
    async updateTask(input) {
      const { taskId, ...rest } = input;
      const patch = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: "Nothing to update.", task: null };
      }
      try {
        const task = await patchTask(bb, taskId, patch);
        return { ok: true, error: null, task };
      } catch (error) {
        return {
          ok: false,
          error: tasksUnavailableMessage(error),
          task: null,
        };
      }
    },
  });

  bb.cli.register({
    name: "tasks-pro",
    summary: "Tasks Pro companion (list / show / comment / update / dispatch / assign)",
    commands: [
      {
        name: "list",
        summary: "List tasks grouped like the Tasks list view",
        usage:
          "bb tasks-pro list [--search <q>] [--project <id>] [--status <status>]... [--priority <priority>]... [--label <name>]... [--active] [--sort manual|priority|due] [--all] [--json]",
      },
      {
        name: "comment",
        summary: "Post a comment via Tasks createComment RPC",
        usage:
          "bb tasks-pro comment <key-or-id> --body <text> [--notify] [--json]",
      },
      {
        name: "update",
        summary: "Update status, priority, or due date via Tasks updateTask RPC",
        usage:
          "bb tasks-pro update <key-or-id> [--status <s>] [--priority <p>] [--due YYYY-MM-DD] [--json]",
      },
      {
        name: "dispatch",
        summary:
          "Spin an agent on a task, optionally on a chosen environment or checkout",
        usage:
          "bb tasks-pro dispatch <key-or-id> [--preset <name>] [--env-id <id> | --path <abs> [--branch <name>] [--host-id <id>] | --profile <name>] [--instructions <text>] [--json]",
      },
      {
        name: "envs",
        summary: "List bb environments Tasks Pro can dispatch into",
        usage: "bb tasks-pro envs [--project <proj_id>] [--json]",
      },
      {
        name: "env-profiles",
        summary: "List saved environment profiles",
        usage: "bb tasks-pro env-profiles [--json]",
      },
      {
        name: "env-profile-set",
        summary: "Create or update a named environment profile",
        usage:
          "bb tasks-pro env-profile-set <name> (--env-id <id> | --path <abs> [--branch <name>] [--host-id <id>]) [--project <proj_id>] [--json]",
      },
      {
        name: "env-profile-rm",
        summary: "Delete a named environment profile",
        usage: "bb tasks-pro env-profile-rm <name-or-id> [--json]",
      },
      {
        name: "assign",
        summary: "Assign a task to me, an existing thread, or a spun agent",
        usage:
          "bb tasks-pro assign <key-or-id> (--me | --thread <thread-id> | --preset <name>) [--no-notify] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const [subcommand, keyOrId, ...rest] = args;

      if (subcommand === "list") {
        const searchIdx = args.indexOf("--search");
        const projectIdx = args.indexOf("--project");
        const sortIdx = args.indexOf("--sort");
        const query = searchIdx >= 0 ? (args[searchIdx + 1] ?? "") : "";
        const projectId = projectIdx >= 0 ? args[projectIdx + 1] : undefined;
        const sortArg = sortIdx >= 0 ? (args[sortIdx + 1] ?? "") : "manual";
        const hideCompleted = !args.includes("--all");
        const workingOnly = args.includes("--active");
        const statuses = flagValues(args, "--status");
        const priorities = flagValues(args, "--priority");
        const labelNames = flagValues(args, "--label");
        if (sortArg && !isTaskSort(sortArg)) {
          return {
            exitCode: 1,
            stderr: `Invalid --sort ${sortArg}. Use manual, priority, or due.\n`,
          };
        }
        for (const status of statuses) {
          if (!isTaskStatus(status)) {
            return {
              exitCode: 1,
              stderr: `Invalid --status ${status}. Use ${TASK_STATUSES.join(", ")}.\n`,
            };
          }
        }
        for (const priority of priorities) {
          if (!isTaskPriority(priority)) {
            return {
              exitCode: 1,
              stderr: `Invalid --priority ${priority}. Use ${TASK_PRIORITIES.join(", ")}.\n`,
            };
          }
        }
        const filters: ListFilters = {
          statuses: statuses.filter(isTaskStatus),
          priorities: priorities.filter(isTaskPriority),
          labelNames,
        };
        try {
          const board = await loadBoard(bb);
          const q = query.trim().toLowerCase();
          const labelIds = selectedLabelIds(
            labelFilterOptions(board.labels),
            labelNames,
          );
          const filtered = board.tasks.filter((task) => {
            if (projectId && task.projectId !== projectId) return false;
            if (workingOnly && (task.workingThreadCount ?? 0) === 0) {
              return false;
            }
            if (
              hideCompleted &&
              statuses.length === 0 &&
              (task.status === "done" || task.status === "canceled")
            ) {
              return false;
            }
            if (!matchesFilters(task, filters, labelIds)) return false;
            if (!q) return true;
            return (
              task.key.toLowerCase().includes(q) ||
              task.title.toLowerCase().includes(q)
            );
          });
          const tasks = sortTasks(filtered, isTaskSort(sortArg) ? sortArg : "manual");
          if (json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ ...board, tasks })}\n`,
            };
          }
          const lines = tasks.map(
            (task) => `${task.key}\t${task.status}\t${task.priority}\t${task.title}`,
          );
          return {
            exitCode: 0,
            stdout: `${lines.join("\n")}${lines.length ? "\n" : ""}`,
          };
        } catch (error) {
          return { exitCode: 1, stderr: `${tasksUnavailableMessage(error)}\n` };
        }
      }

      if (subcommand === "show") {
        if (!keyOrId) {
          return {
            exitCode: 1,
            stderr: "Usage: bb tasks-pro show <key-or-id> [--json]\n",
          };
        }
        const view = await getViewHandler({ keyOrId });
        if (json) {
          return { exitCode: view.task ? 0 : 1, stdout: `${JSON.stringify(view)}\n` };
        }
        if (!view.task) {
          return {
            exitCode: 1,
            stderr: `${view.error ?? "Task not found."}\n`,
          };
        }
        const lines = [
          `${view.task.key} · ${view.task.title}`,
          `status: ${view.task.status}`,
          `priority: ${view.task.priority}`,
          `labels: ${view.labels.filter((l) => view.task!.labelIds.includes(l.id)).map((l) => l.name).join(", ") || "(none)"}`,
          `comments: ${view.comments.length}`,
          `attachments: ${view.attachments.length}`,
          "",
        ];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      if (subcommand === "comment") {
        if (!keyOrId) {
          return {
            exitCode: 1,
            stderr:
              "Usage: bb tasks-pro comment <key-or-id> --body <text> [--notify] [--json]\n",
          };
        }
        const notify = rest.includes("--notify");
        const bodyIdx = rest.indexOf("--body");
        const body =
          bodyIdx >= 0 && rest[bodyIdx + 1] ? rest[bodyIdx + 1]! : "";
        if (!body.trim()) {
          return {
            exitCode: 1,
            stderr: "Pass --body <text>.\n",
          };
        }
        const view = await getViewHandler({ keyOrId });
        if (!view.task) {
          return {
            exitCode: 1,
            stderr: `${view.error ?? "Task not found."}\n`,
          };
        }
        const result = await postCommentHandler({
          taskId: view.task.id,
          body,
          notify,
        });
        if (json) {
          return {
            exitCode: result.ok ? 0 : 1,
            stdout: `${JSON.stringify(result)}\n`,
          };
        }
        if (!result.ok) {
          return { exitCode: 1, stderr: `${result.error}\n` };
        }
        return {
          exitCode: 0,
          stdout: `Commented on ${view.task.key}  ${result.comment?.id ?? ""}\n`,
        };
      }

      if (subcommand === "update") {
        if (!keyOrId) {
          return {
            exitCode: 1,
            stderr:
              "Usage: bb tasks-pro update <key-or-id> [--status <s>] [--priority <p>] [--due YYYY-MM-DD] [--json]\n",
          };
        }
        const flag = (name: string) => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const view = await getViewHandler({ keyOrId });
        if (!view.task) {
          return {
            exitCode: 1,
            stderr: `${view.error ?? "Task not found."}\n`,
          };
        }
        const status = flag("--status");
        const priority = flag("--priority");
        const due = flag("--due");
        if (!status && !priority && due === undefined) {
          return {
            exitCode: 1,
            stderr: "Pass --status, --priority, and/or --due.\n",
          };
        }
        try {
          const task = await patchTask(bb, view.task.id, {
            ...(status ? { status } : {}),
            ...(priority ? { priority } : {}),
            ...(due !== undefined ? { dueDate: due } : {}),
          });
          if (json) {
            return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, task })}\n` };
          }
          return {
            exitCode: 0,
            stdout: `Updated ${task.key}  status=${task.status} priority=${task.priority}\n`,
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: `${tasksUnavailableMessage(error)}\n`,
          };
        }
      }

      if (subcommand === "dispatch") {
        if (!keyOrId) {
          return { exitCode: 1, stderr: `${DISPATCH_USAGE}\n` };
        }
        const flag = (name: string) => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const presetName = flag("--preset")?.trim() || DEFAULT_PRESET_NAME;
        const extraInstructions = flag("--instructions");

        let envTarget: EnvTarget | undefined;
        try {
          envTarget = buildCliEnvTarget({
            envId: flag("--env-id"),
            path: flag("--path"),
            branch: flag("--branch"),
            profile: flag("--profile"),
            hostId: flag("--host-id"),
          });
          // Resolve up front so a bad path or an unknown profile is reported
          // before the task lookup, not after it.
          if (envTarget) await resolveEnvTarget(bb, envTarget);
        } catch (error) {
          return { exitCode: 1, stderr: `${dispatchErrorMessage(error)}\n` };
        }

        const view = await getViewHandler({ keyOrId });
        if (!view.task) {
          return {
            exitCode: 1,
            stderr: `${view.error ?? "Task not found."}\n`,
          };
        }
        try {
          const presets = await fetchTaskPresets(bb);
          const preset =
            presets.find(
              (item) => item.name.toLowerCase() === presetName.toLowerCase(),
            ) ?? presets.find((item) => item.id === presetName);
          if (!preset) {
            const names = presets.map((item) => item.name).join(", ") || "(none)";
            return {
              exitCode: 1,
              stderr: `No preset named “${presetName}”. Available: ${names}\n`,
            };
          }
          const result = await runDispatch(bb, {
            taskId: view.task.id,
            presetId: preset.id,
            extraInstructions,
            envTarget,
            preset,
          });
          if (json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({
                ok: true,
                threadId: result.threadId,
                preset: preset.name,
                via: result.via,
                environmentId: result.environmentId,
              })}\n`,
            };
          }
          const where =
            result.via === "spawn"
              ? ` in ${result.environmentId ?? "the requested environment"}`
              : "";
          return {
            exitCode: 0,
            stdout: `Started ${preset.name} on ${view.task.key}${where} (${result.threadId})\n`,
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: `${dispatchErrorMessage(error)}\n`,
          };
        }
      }

      if (subcommand === "env-profiles") {
        try {
          const profiles = await fetchEnvProfiles(bb);
          if (json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ ok: true, profiles })}\n`,
            };
          }
          if (profiles.length === 0) {
            return {
              exitCode: 0,
              stdout:
                "No env profiles. Add one with `bb tasks-pro env-profile-set <name> --path <abs>`.\n",
            };
          }
          const lines = profiles.map((profile) => {
            const where =
              profile.kind === "reuse"
                ? (profile.environmentId ?? "(missing environmentId)")
                : `${profile.path ?? "(missing path)"}${
                    profile.branch ? ` @${profile.branch}` : ""
                  }`;
            const host = profile.hostId ? `  ${profile.hostId}` : "";
            const scope = profile.bbProjectId ? `  ${profile.bbProjectId}` : "";
            return `${profile.name}  ${profile.kind}  ${where}${host}${scope}`;
          });
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${dispatchErrorMessage(error)}\n` };
        }
      }

      if (subcommand === "env-profile-set") {
        if (!keyOrId) {
          return { exitCode: 1, stderr: `${ENV_PROFILE_SET_USAGE}\n` };
        }
        const flag = (name: string) => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const envId = flag("--env-id")?.trim();
        const path = flag("--path")?.trim();
        if ((envId ? 1 : 0) + (path ? 1 : 0) !== 1) {
          return {
            exitCode: 1,
            stderr: "Pass exactly one of --env-id or --path.\n",
          };
        }
        try {
          const existing = await findEnvProfile(bb, keyOrId);
          const profile = await writeEnvProfile(bb, {
            ...(existing ? { id: existing.id } : {}),
            name: keyOrId,
            kind: envId ? "reuse" : "path",
            environmentId: envId ?? null,
            path: path ?? null,
            branch: flag("--branch")?.trim() ?? null,
            hostId: flag("--host-id")?.trim() ?? null,
            bbProjectId: flag("--project")?.trim() ?? null,
          });
          if (json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ ok: true, profile })}\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `Saved env profile ${profile.name} (${profile.id})\n`,
          };
        } catch (error) {
          return { exitCode: 1, stderr: `${dispatchErrorMessage(error)}\n` };
        }
      }

      if (subcommand === "env-profile-rm") {
        if (!keyOrId) {
          return {
            exitCode: 1,
            stderr: "Usage: bb tasks-pro env-profile-rm <name-or-id> [--json]\n",
          };
        }
        try {
          const removed = await removeEnvProfile(bb, keyOrId);
          if (!removed) {
            return {
              exitCode: 1,
              stderr: `No env profile named “${keyOrId}”.\n`,
            };
          }
          if (json) {
            return { exitCode: 0, stdout: `${JSON.stringify({ ok: true })}\n` };
          }
          return { exitCode: 0, stdout: `Removed env profile ${keyOrId}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${dispatchErrorMessage(error)}\n` };
        }
      }

      if (subcommand === "envs") {
        const projectIdx = args.indexOf("--project");
        const bbProjectId =
          projectIdx >= 0 ? (args[projectIdx + 1]?.trim() ?? null) : null;
        try {
          const environments = await listEnvironmentOptions(bb, { bbProjectId });
          if (json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ ok: true, environments })}\n`,
            };
          }
          if (environments.length === 0) {
            return {
              exitCode: 0,
              stdout: "No environments found on recent threads.\n",
            };
          }
          const lines = environments.map(
            (environment) =>
              `${environment.id}  ${environment.status}  ${environment.hostId}  ${
                environment.name
              }  ${environment.path ?? "(no path)"}${
                environment.branchName ? ` @${environment.branchName}` : ""
              }`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${dispatchErrorMessage(error)}\n` };
        }
      }

      if (subcommand === "assign") {
        if (!keyOrId) {
          return {
            exitCode: 1,
            stderr:
              "Usage: bb tasks-pro assign <key-or-id> (--me | --thread <thread-id> | --preset <name>) [--no-notify] [--json]\n",
          };
        }
        const flag = (name: string) => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const toMe = rest.includes("--me");
        const threadId = flag("--thread");
        const presetName = flag("--preset")?.trim();
        const modes = [toMe, Boolean(threadId), Boolean(presetName)].filter(
          Boolean,
        ).length;
        if (modes !== 1) {
          return {
            exitCode: 1,
            stderr:
              "Pick exactly one of --me, --thread <id>, or --preset <name>.\n",
          };
        }
        const view = await getViewHandler({ keyOrId });
        if (!view.task) {
          return {
            exitCode: 1,
            stderr: `${view.error ?? "Task not found."}\n`,
          };
        }
        try {
          if (toMe) {
            const result = await assignTaskToMe(bb, view.task.id);
            if (json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({ ok: true, ...result })}\n`,
              };
            }
            return {
              exitCode: 0,
              stdout: `Assigned ${result.task.key} to me\n`,
            };
          }
          if (threadId) {
            const result = await assignTaskToThread(bb, {
              taskId: view.task.id,
              threadId,
              notifyThread: !rest.includes("--no-notify"),
            });
            if (json) {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({ ok: true, ...result })}\n`,
              };
            }
            return {
              exitCode: 0,
              stdout: `Assigned ${result.task.key} to ${result.threadId}\n`,
            };
          }
          const presets = await fetchTaskPresets(bb);
          const preset =
            presets.find(
              (item) =>
                item.name.toLowerCase() === (presetName ?? "").toLowerCase(),
            ) ?? presets.find((item) => item.id === presetName);
          if (!preset) {
            const names = presets.map((item) => item.name).join(", ") || "(none)";
            return {
              exitCode: 1,
              stderr: `No preset named “${presetName}”. Available: ${names}\n`,
            };
          }
          const spunId = await spawnTaskAgent(bb, {
            taskId: view.task.id,
            presetId: preset.id,
          });
          const assignee = await recordAgentAssignee(bb, {
            taskId: view.task.id,
            threadId: spunId,
            presetName: preset.name,
          });
          if (json) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({ ok: true, threadId: spunId, assignee, preset: preset.name })}\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `Assigned ${view.task.key} to new ${preset.name} agent (${spunId})\n`,
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: `${tasksUnavailableMessage(error)}\n`,
          };
        }
      }

      return {
        exitCode: 1,
        stderr:
          "Usage:\n  bb tasks-pro list [--search <q>] [--project <id>] [--status <status>]... [--priority <priority>]... [--label <name>]... [--active] [--sort manual|priority|due] [--all] [--json]\n  bb tasks-pro show <key-or-id> [--json]\n  bb tasks-pro comment <key-or-id> --body <text> [--notify] [--json]\n  bb tasks-pro update <key-or-id> [--status <s>] [--priority <p>] [--due YYYY-MM-DD] [--json]\n  bb tasks-pro dispatch <key-or-id> [--preset <name>] [--env-id <id> | --path <abs> [--branch <name>] [--host-id <id>] | --profile <name>] [--instructions <text>] [--json]\n  bb tasks-pro assign <key-or-id> (--me | --thread <thread-id> | --preset <name>) [--no-notify] [--json]\n  bb tasks-pro envs [--project <proj_id>] [--json]\n  bb tasks-pro env-profiles [--json]\n  bb tasks-pro env-profile-set <name> (--env-id <id> | --path <abs> [--branch <name>] [--host-id <id>]) [--project <proj_id>] [--json]\n  bb tasks-pro env-profile-rm <name-or-id> [--json]\n",
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("tasks-pro disposed");
  });
}
