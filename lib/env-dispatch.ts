// Env-aware dispatch for Tasks Pro (TPRO-3).
//
// Tasks' `delegate` RPC decides the environment from the preset's
// `environmentKind`, which is only `project-default` or `new-worktree`. When
// the caller names an explicit environment we bypass `delegate`, spawn the
// thread ourselves with `bb.sdk.threads.spawn`, and attach it back to the task
// through the Tasks `taskThreadsAttach` RPC. The seed prompt is rebuilt here so
// the agent gets the same context Tasks would have given it, plus the filtered
// user/agent comment pack Tasks Pro already ships.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  formatDispatchCommentPack,
  listSubtasks,
  loadTaskView,
  patchTask,
  postComment,
  TASKS_PLUGIN_ID,
  type AttachmentRecord,
  type PresetRecord,
  type TaskRecord,
  type TaskView,
} from "./tasks-bridge";
import {
  applyDefaultHost,
  describeEnvTarget,
  EnvTargetError,
  toSpawnEnvironment,
  validateEnvTarget,
  type ResolvedEnvTarget,
} from "./env-target";
import { statusLabel } from "./model";

const attachOut = z.object({ threadId: z.string().startsWith("thr_") });

export type EnvDispatchResult = {
  threadId: string;
  environmentId: string | null;
  target: ResolvedEnvTarget;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSubtasks(subtasks: TaskRecord[]): string {
  if (subtasks.length === 0) return "None.";
  return subtasks
    .map((task) => `- ${task.key} · ${task.title} (${statusLabel(task.status)})`)
    .join("\n");
}

function formatAttachments(attachments: AttachmentRecord[]): string {
  if (attachments.length === 0) return "None.";
  return attachments
    .map(
      (row) =>
        `- ${row.fileName} (${row.mime}, ${formatBytes(row.sizeBytes)})`,
    )
    .join("\n");
}

function reportBackContract(task: TaskRecord): string {
  return [
    `You are working on task ${task.key}. Use the bb tasks CLI: comment substantive`,
    `updates (\`bb tasks comment ${task.key} --body ...\`), attach result artifacts,`,
    `set status when done (\`bb tasks update ${task.key} --status in_review\`) or`,
    "explain blockage in a comment. Your thread is already attached to the task.",
  ].join(" ");
}

/**
 * Rebuild the delegate seed prompt. Section order matches Tasks so an agent
 * reading either prompt sees the same structure.
 */
export function buildSeedPrompt(input: {
  view: TaskView;
  subtasks: TaskRecord[];
  preset: PresetRecord;
  target: ResolvedEnvTarget;
  extraInstructions?: string;
}): string {
  const { view, subtasks, preset, target } = input;
  const task = view.task;
  const parts: string[] = [`# ${task.key} · ${task.title}`];

  parts.push("", "## Description", "");
  parts.push(task.description.trim() || "_No description._");

  parts.push("", "## Project context", "");
  parts.push(`- Name: ${view.project?.name ?? "(unknown)"}`);
  parts.push(
    `- Linked bb project: ${view.project?.linkedBbProjectId ?? "(none)"}`,
  );
  parts.push(`- Status: ${statusLabel(task.status)}`);
  if (task.dueDate) parts.push(`- Due: ${task.dueDate}`);

  parts.push("", "## Environment", "");
  if (target.kind === "reuse") {
    parts.push(
      `You are running in the existing bb environment ${target.environmentId}.`,
    );
  } else if (target.kind === "path") {
    parts.push(`You are running in the checkout at ${target.path}.`);
    if (target.branch) {
      parts.push(`The environment is on the existing branch ${target.branch}.`);
    }
  } else {
    parts.push("You are running in the preset's default environment.");
  }
  parts.push(
    "This is already the right working directory. Do not call",
    "`update_environment_directory` and do not stop to ask for a directory change.",
  );

  parts.push("", "## Sub-tasks", "", formatSubtasks(subtasks));
  parts.push("", "## Attachments", "", formatAttachments(view.attachments));

  const pack = formatDispatchCommentPack(view.comments);
  if (pack) parts.push("", pack);

  parts.push("", "## Report-back contract", "", reportBackContract(task));

  const presetInstructions = preset.instructions?.trim();
  if (presetInstructions) {
    parts.push("", "## Preset instructions", "", presetInstructions);
  }

  const extra = input.extraInstructions?.trim();
  if (extra) {
    parts.push("", "## Additional instructions", "", extra);
  }

  return parts.join("\n");
}

/** Preset reasoning levels are a subset of the spawn enum; pass through safely. */
const SPAWN_REASONING_LEVELS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);

const SPAWN_PERMISSION_MODES = new Set(["auto", "accept-edits", "full"]);

/**
 * Spawn a thread on an explicit environment and attach it to the task.
 * Only called when the caller asked for `reuse` or `path`; the preset path
 * still goes through Tasks `delegate`.
 */
export async function dispatchTaskToEnvironment(
  bb: BbPluginApi,
  input: {
    taskId: string;
    preset: PresetRecord;
    target: Exclude<ResolvedEnvTarget, { kind: "preset" }>;
    extraInstructions?: string;
  },
): Promise<EnvDispatchResult> {
  const view = await loadTaskView(bb, input.taskId);
  if (!view) throw new EnvTargetError("Task not found.");

  const bbProjectId = view.project?.linkedBbProjectId?.trim();
  if (!bbProjectId) {
    throw new EnvTargetError(
      `Tasks project “${view.project?.name ?? view.task.projectId}” has no linked bb project. ` +
        "Link one in Tasks before dispatching to an explicit environment.",
    );
  }

  // A host path needs a host. Default it to the one that owns the project.
  const target = (await applyDefaultHost(
    bb,
    input.target,
    bbProjectId,
  )) as Exclude<ResolvedEnvTarget, { kind: "preset" }>;
  await validateEnvTarget(bb, target);

  const subtasks = await listSubtasks(bb, view.task.id);
  const prompt = buildSeedPrompt({
    view,
    subtasks,
    preset: input.preset,
    target,
    extraInstructions: input.extraInstructions,
  });

  const reasoningLevel = SPAWN_REASONING_LEVELS.has(input.preset.reasoningLevel)
    ? input.preset.reasoningLevel
    : "medium";
  const permissionMode = SPAWN_PERMISSION_MODES.has(input.preset.permissionMode)
    ? input.preset.permissionMode
    : "auto";

  const thread = await bb.sdk.threads.spawn({
    projectId: bbProjectId,
    providerId: input.preset.providerId,
    model: input.preset.modelId,
    reasoningLevel: reasoningLevel as "low" | "medium" | "high" | "xhigh" | "max",
    permissionMode: permissionMode as "auto" | "accept-edits" | "full",
    // Without provenance the server drops the requested provider/model and
    // re-derives them from the project defaults, silently ignoring the preset.
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
    environment: toSpawnEnvironment(target),
    // Tasks Pro parses "KEY · title" back to a task in findTaskForThread.
    title: `${view.task.key} · ${view.task.title}`,
    input: [{ type: "text", text: prompt, mentions: [] }],
  });

  await bb.sdk.plugins.callRpc({
    pluginId: TASKS_PLUGIN_ID,
    method: "taskThreadsAttach",
    input: { taskId: view.task.id, threadId: thread.id },
    outputSchema: attachOut,
  });

  if (view.task.status === "backlog" || view.task.status === "todo") {
    await patchTask(bb, view.task.id, { status: "in_progress" });
  }

  await postComment(bb, {
    taskId: view.task.id,
    body: `Spun ${input.preset.name} on ${describeEnvTarget(target)} · ${thread.id}`,
    notify: false,
  });

  return {
    threadId: thread.id,
    environmentId: thread.environmentId ?? null,
    target,
  };
}
