export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

/** Same tokens as the official Tasks `StatusIcon`. */
export const STATUS_COLORS: Record<TaskStatus, string> = {
  backlog: "var(--muted-foreground)",
  todo: "var(--muted-foreground)",
  in_progress: "var(--attention)",
  in_review: "var(--timeline-accent)",
  done: "var(--success)",
  canceled: "var(--muted-foreground)",
};

export const STATUS_TEXT_CLASS: Record<TaskStatus, string> = {
  backlog: "text-muted-foreground",
  todo: "text-muted-foreground",
  in_progress: "text-attention",
  in_review: "text-timeline-accent",
  done: "text-success",
  canceled: "text-muted-foreground",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function statusLabel(status: string): string {
  return isTaskStatus(status) ? STATUS_LABELS[status] : status.replace(/_/g, " ");
}

export function priorityLabel(priority: string): string {
  return isTaskPriority(priority) ? PRIORITY_LABELS[priority] : priority;
}

export const DEFAULT_PRESET_NAME = "Cursor Auto";

export const PRESET_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const PRESET_PERMISSION_MODES = [
  "accept-edits",
  "auto",
  "full",
] as const;

export const PRESET_ENVIRONMENT_KINDS = [
  "project-default",
  "new-worktree",
] as const;

export type PresetReasoningLevel = (typeof PRESET_REASONING_LEVELS)[number];
export type PresetPermissionMode = (typeof PRESET_PERMISSION_MODES)[number];
export type PresetEnvironmentKind = (typeof PRESET_ENVIRONMENT_KINDS)[number];

export const PRESET_PERMISSION_LABELS: Record<PresetPermissionMode, string> = {
  "accept-edits": "Accept Edits",
  auto: "Approve for me",
  full: "Full Access",
};

export const PRESET_ENVIRONMENT_LABELS: Record<PresetEnvironmentKind, string> = {
  "project-default": "Project default",
  "new-worktree": "New worktree",
};

export function isPresetReasoningLevel(
  value: string,
): value is PresetReasoningLevel {
  return (PRESET_REASONING_LEVELS as readonly string[]).includes(value);
}

export function isPresetPermissionMode(
  value: string,
): value is PresetPermissionMode {
  return (PRESET_PERMISSION_MODES as readonly string[]).includes(value);
}

export function isPresetEnvironmentKind(
  value: string,
): value is PresetEnvironmentKind {
  return (PRESET_ENVIRONMENT_KINDS as readonly string[]).includes(value);
}

export const THREAD_STATUS_META: Record<
  string,
  { label: string; dotClassName: string; textClassName: string }
> = {
  starting: {
    label: "Starting",
    dotClassName: "bg-attention animate-pulse",
    textClassName: "text-attention",
  },
  working: {
    label: "Working",
    dotClassName: "bg-success animate-pulse",
    textClassName: "text-success",
  },
  idle: {
    label: "Idle",
    dotClassName: "bg-muted-foreground",
    textClassName: "text-muted-foreground",
  },
  completed: {
    label: "Completed",
    dotClassName: "bg-muted",
    textClassName: "text-muted-foreground",
  },
  failed: {
    label: "Failed",
    dotClassName: "bg-destructive",
    textClassName: "text-destructive",
  },
};

export const PR_STATE_META: Record<
  string,
  { label: string; icon: "GitPullRequestArrow" | "GitPullRequestDraft" | "GitMerge" | "GitPullRequestClosed"; textClassName: string }
> = {
  open: {
    label: "Open",
    icon: "GitPullRequestArrow",
    textClassName: "text-success",
  },
  draft: {
    label: "Draft",
    icon: "GitPullRequestDraft",
    textClassName: "text-muted-foreground",
  },
  merged: {
    label: "Merged",
    icon: "GitMerge",
    textClassName: "text-pr-merged",
  },
  closed: {
    label: "Closed",
    icon: "GitPullRequestClosed",
    textClassName: "text-destructive",
  },
};

/** Same palette as the official Tasks project color picker. */
export const PROJECT_COLOR_PALETTE = [
  { value: "slateblue", label: "Indigo" },
  { value: "steelblue", label: "Blue" },
  { value: "lightseagreen", label: "Teal" },
  { value: "mediumseagreen", label: "Green" },
  { value: "goldenrod", label: "Yellow" },
  { value: "sandybrown", label: "Orange" },
  { value: "indianred", label: "Red" },
  { value: "palevioletred", label: "Pink" },
  { value: "mediumpurple", label: "Purple" },
  { value: "slategray", label: "Gray" },
] as const;

export const DEFAULT_PROJECT_COLOR = PROJECT_COLOR_PALETTE[0].value;

export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;

export function deriveProjectPrefix(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const raw =
    words.length >= 2
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return raw.replace(/^[0-9]+/, "").slice(0, 10);
}

export function describeCreateProjectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") && message.includes("prefix")) {
    return "That prefix is already used by another project.";
  }
  return message;
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).valueOf();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1e3);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
