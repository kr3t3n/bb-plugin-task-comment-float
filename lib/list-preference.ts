import {
  TASK_PRIORITIES,
  isTaskPriority,
  isTaskStatus,
  type TaskPriority,
  type TaskStatus,
} from "./model";

export const TASK_SORTS = ["manual", "priority", "due"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const SORT_LABELS: Record<TaskSort, string> = {
  manual: "Manual",
  priority: "Priority",
  due: "Due date",
};

export type ListFilters = {
  statuses: TaskStatus[];
  priorities: TaskPriority[];
  labelNames: string[];
};

export type ListPreference = {
  filters: ListFilters;
  sort: TaskSort;
};

export const EMPTY_FILTERS: ListFilters = {
  statuses: [],
  priorities: [],
  labelNames: [],
};

export function hasActiveFilters(filters: ListFilters): boolean {
  return (
    filters.statuses.length > 0 ||
    filters.priorities.length > 0 ||
    filters.labelNames.length > 0
  );
}

export function listPreferenceScope(
  projectId: string,
  activeOnly: boolean,
): string {
  if (activeOnly) return "active";
  if (projectId) return `project:${projectId}`;
  return "all";
}

export function isTaskSort(value: string): value is TaskSort {
  return (TASK_SORTS as readonly string[]).includes(value);
}

function uniqueAllowed<T extends string>(
  values: unknown,
  allow: (value: string) => value is T,
): T[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !allow(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueLabelNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function sanitizeListPreference(raw: unknown): ListPreference {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const filtersRaw =
    record.filters && typeof record.filters === "object"
      ? (record.filters as Record<string, unknown>)
      : record;
  const sort = typeof record.sort === "string" ? record.sort : "";
  return {
    filters: {
      statuses: uniqueAllowed(filtersRaw.statuses, isTaskStatus),
      priorities: uniqueAllowed(filtersRaw.priorities, isTaskPriority),
      labelNames: uniqueLabelNames(filtersRaw.labelNames),
    },
    sort: isTaskSort(sort) ? sort : "manual",
  };
}

const STORAGE_KEY = "task-comment-float:list-preferences";
const VERSION = 1;

function readStorage(): {
  version: number;
  scopes: Record<string, unknown>;
  isFutureVersion: boolean;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { version?: unknown; scopes?: unknown };
    const version = typeof record.version === "number" ? record.version : 0;
    const scopes =
      record.scopes && typeof record.scopes === "object"
        ? (record.scopes as Record<string, unknown>)
        : {};
    return { version, scopes, isFutureVersion: version > VERSION };
  } catch {
    return null;
  }
}

export function loadListPreference(scope: string): ListPreference {
  if (typeof window === "undefined") {
    return { filters: { ...EMPTY_FILTERS }, sort: "manual" };
  }
  const document = readStorage();
  if (document === null) {
    return { filters: { ...EMPTY_FILTERS }, sort: "manual" };
  }
  return sanitizeListPreference(document.scopes[scope]);
}

export function storeListPreference(
  scope: string,
  preference: ListPreference,
): void {
  if (typeof window === "undefined") return;
  const sanitized = sanitizeListPreference(preference);
  try {
    const existing = readStorage();
    if (existing?.isFutureVersion) return;
    const scopes = { ...existing?.scopes };
    scopes[scope] = sanitized;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: VERSION, scopes }),
    );
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function toggled<T>(values: T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((existing) => existing !== value);
}

export type LabelFilterOption = {
  name: string;
  color: string;
  labelIds: string[];
};

export function labelFilterOptions(
  labels: { id: string; name: string; color: string }[],
): LabelFilterOption[] {
  const byName = new Map<string, LabelFilterOption>();
  for (const label of labels) {
    const existing = byName.get(label.name);
    if (existing) existing.labelIds.push(label.id);
    else {
      byName.set(label.name, {
        name: label.name,
        color: label.color,
        labelIds: [label.id],
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function selectedLabelIds(
  options: LabelFilterOption[],
  selectedNames: string[],
): string[] {
  const selected = new Set(selectedNames);
  return options
    .filter((option) => selected.has(option.name))
    .flatMap((option) => option.labelIds);
}

export function matchesFilters(
  task: { status: string; priority: string; labelIds: string[] },
  filters: ListFilters,
  labelIds: string[],
): boolean {
  return (
    (filters.statuses.length === 0 || filters.statuses.includes(task.status as TaskStatus)) &&
    (filters.priorities.length === 0 ||
      filters.priorities.includes(task.priority as TaskPriority)) &&
    (labelIds.length === 0 || task.labelIds.some((id) => labelIds.includes(id)))
  );
}

const PRIORITY_RANK = new Map(
  TASK_PRIORITIES.map((priority, index) => [priority, index]),
);

function byPriority(
  a: { priority: string; dueDate: string | null },
  b: { priority: string; dueDate: string | null },
): number {
  return (
    (PRIORITY_RANK.get(a.priority as TaskPriority) ?? TASK_PRIORITIES.length) -
    (PRIORITY_RANK.get(b.priority as TaskPriority) ?? TASK_PRIORITIES.length)
  );
}

function byDueDate(
  a: { dueDate: string | null },
  b: { dueDate: string | null },
): number {
  if (a.dueDate === null) return b.dueDate === null ? 0 : 1;
  if (b.dueDate === null) return -1;
  return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
}

export function sortTasks<T extends { priority: string; dueDate: string | null }>(
  tasks: readonly T[],
  sort: TaskSort,
): T[] {
  if (sort === "manual") return [...tasks];
  const [primary, secondary] =
    sort === "priority" ? [byPriority, byDueDate] : [byDueDate, byPriority];
  return [...tasks].sort((a, b) => primary(a, b) || secondary(a, b));
}
