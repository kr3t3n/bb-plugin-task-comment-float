import { describe, expect, it } from "vitest";
import { buildSeedPrompt } from "./env-dispatch";
import type {
  AttachmentRecord,
  CommentRecord,
  PresetRecord,
  TaskRecord,
  TaskView,
} from "./tasks-bridge";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "tid_1",
    projectId: "pid_1",
    number: 3,
    key: "TPRO-3",
    title: "Env-aware dispatch",
    description: "Land agents on a chosen checkout in one turn.",
    status: "todo",
    priority: "high",
    dueDate: null,
    parentTaskId: null,
    labelIds: [],
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    ...overrides,
  };
}

function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: "cid_1",
    taskId: "tid_1",
    kind: "user",
    authorName: "Georgi",
    presetName: null,
    threadId: null,
    body: "Coordinate the RPC shape with TPRO-4.",
    notifiedCount: 0,
    createdAt: "2026-09-06T11:00:00.000Z",
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "aid_1",
    taskId: "tid_1",
    commentId: null,
    fileName: "smoke.log",
    mime: "text/plain",
    sizeBytes: 2048,
    isImage: false,
    createdAt: "2026-09-06T11:30:00.000Z",
    ...overrides,
  };
}

function preset(overrides: Partial<PresetRecord> = {}): PresetRecord {
  return {
    id: "preset_1",
    name: "Cursor Auto",
    providerId: "acp-cursor",
    modelId: "auto",
    reasoningLevel: "high",
    permissionMode: "full",
    environmentKind: "project-default",
    baseBranch: null,
    machineId: null,
    instructions: "Plow ahead. State assumptions and continue.",
    builtin: false,
    ...overrides,
  };
}

function view(overrides: Partial<TaskView> = {}): TaskView {
  return {
    task: task(),
    comments: [],
    attachments: [],
    labels: [],
    project: {
      id: "pid_1",
      name: "Tasks Pro",
      prefix: "TPRO",
      color: "slateblue",
      folderId: null,
      linkedBbProjectId: "proj_dcf7pm7baf",
    },
    threads: [],
    pullRequests: [],
    unavailableThreadIds: [],
    ...overrides,
  };
}

describe("buildSeedPrompt", () => {
  it("opens with the key and title Tasks Pro parses back", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "path", path: "/home/bb/projects/sre-uat", branch: null, hostId: null },
    });
    expect(prompt.startsWith("# TPRO-3 · Env-aware dispatch\n")).toBe(true);
  });

  it("names the checkout and forbids a mid-turn directory switch", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "path", path: "/home/bb/projects/sre-uat", branch: "uat", hostId: null },
    });
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain(
      "You are running in the checkout at /home/bb/projects/sre-uat.",
    );
    expect(prompt).toContain("existing branch uat");
    expect(prompt).toContain("update_environment_directory");
  });

  it("names the reused environment", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain(
      "You are running in the existing bb environment env_42.",
    );
  });

  it("carries project context including the linked bb project", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("- Name: Tasks Pro");
    expect(prompt).toContain("- Linked bb project: proj_dcf7pm7baf");
    expect(prompt).toContain("- Status: Todo");
  });

  it("writes None for empty sub-tasks and attachments", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("## Sub-tasks\n\nNone.");
    expect(prompt).toContain("## Attachments\n\nNone.");
  });

  it("lists sub-tasks and attachments when present", () => {
    const prompt = buildSeedPrompt({
      view: view({ attachments: [attachment()] }),
      subtasks: [
        task({ id: "tid_2", number: 4, key: "TPRO-4", title: "Spin UI", status: "in_progress" }),
      ],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("- TPRO-4 · Spin UI (In Progress)");
    expect(prompt).toContain("- smoke.log (text/plain, 2 KB)");
  });

  it("includes the filtered user/agent comment pack and drops system rows", () => {
    const prompt = buildSeedPrompt({
      view: view({
        comments: [
          comment(),
          comment({
            id: "cid_2",
            kind: "system",
            body: "Status changed to In Progress",
            createdAt: "2026-09-06T11:05:00.000Z",
          }),
        ],
      }),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("## Task comments (user + agent)");
    expect(prompt).toContain("Coordinate the RPC shape with TPRO-4.");
    expect(prompt).not.toContain("Status changed to In Progress");
  });

  it("drops Tasks Pro's own bookkeeping comments from the pack", () => {
    const prompt = buildSeedPrompt({
      view: view({
        comments: [
          comment({
            id: "cid_3",
            body: "Spun Composer fast on /srv/uat · thr_abc123",
            createdAt: "2026-09-06T11:10:00.000Z",
          }),
          comment({
            id: "cid_4",
            body: "Assigned to me",
            createdAt: "2026-09-06T11:11:00.000Z",
          }),
          comment({
            id: "cid_5",
            body: "Assigned to existing thread · Some agent (thr_def456)",
            createdAt: "2026-09-06T11:12:00.000Z",
          }),
          comment({ id: "cid_6", body: "A real note worth keeping." }),
        ],
      }),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("A real note worth keeping.");
    expect(prompt).not.toContain("Spun Composer fast");
    expect(prompt).not.toContain("Assigned to me");
    expect(prompt).not.toContain("Assigned to existing thread");
  });

  it("omits the comment section when only bookkeeping rows exist", () => {
    const prompt = buildSeedPrompt({
      view: view({
        comments: [
          comment({ body: "Spun Composer fast on /srv/uat · thr_abc123" }),
        ],
      }),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).not.toContain("## Task comments");
  });

  it("always states the report-back contract with the task key", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("## Report-back contract");
    expect(prompt).toContain("bb tasks comment TPRO-3 --body ...");
    expect(prompt).toContain("bb tasks update TPRO-3 --status in_review");
  });

  it("appends preset and additional instructions in that order", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
      extraInstructions: "Stay inside bb-plugin-task-comment-float.",
    });
    expect(prompt.indexOf("## Preset instructions")).toBeGreaterThan(
      prompt.indexOf("## Report-back contract"),
    );
    expect(prompt.indexOf("## Additional instructions")).toBeGreaterThan(
      prompt.indexOf("## Preset instructions"),
    );
    expect(prompt).toContain("Stay inside bb-plugin-task-comment-float.");
  });

  it("omits empty instruction sections", () => {
    const prompt = buildSeedPrompt({
      view: view(),
      subtasks: [],
      preset: preset({ instructions: "   " }),
      target: { kind: "reuse", environmentId: "env_42" },
      extraInstructions: "  ",
    });
    expect(prompt).not.toContain("## Preset instructions");
    expect(prompt).not.toContain("## Additional instructions");
  });

  it("falls back to a placeholder description", () => {
    const prompt = buildSeedPrompt({
      view: view({ task: task({ description: "" }) }),
      subtasks: [],
      preset: preset(),
      target: { kind: "reuse", environmentId: "env_42" },
    });
    expect(prompt).toContain("_No description._");
  });
});
