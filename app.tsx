// Tasks Pro — companion panel for official Tasks.
// List view matches Tasks grouping; detail keeps a sticky composer.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { ListFilterBar } from "@/components/list-filter-bar";
import { StatusIcon } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  labelFilterOptions,
  listPreferenceScope,
  loadListPreference,
  matchesFilters,
  selectedLabelIds,
  sortTasks,
  storeListPreference,
  type ListFilters,
  type ListPreference,
  type TaskSort,
} from "@/lib/list-preference";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PRESET_NAME,
  DEFAULT_PROJECT_COLOR,
  PR_STATE_META,
  PRESET_ENVIRONMENT_KINDS,
  PRESET_ENVIRONMENT_LABELS,
  PRESET_PERMISSION_LABELS,
  PRESET_PERMISSION_MODES,
  PRESET_REASONING_LEVELS,
  PRIORITY_LABELS,
  PROJECT_COLOR_PALETTE,
  PROJECT_PREFIX_PATTERN,
  STATUS_LABELS,
  STATUS_TEXT_CLASS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THREAD_STATUS_META,
  deriveProjectPrefix,
  describeCreateProjectError,
  formatRelativeTime,
  isPresetEnvironmentKind,
  isPresetPermissionMode,
  isPresetReasoningLevel,
  isTaskStatus,
  priorityLabel,
  statusLabel,
  type PresetEnvironmentKind,
  type PresetPermissionMode,
  type PresetReasoningLevel,
  type TaskPriority,
  type TaskStatus,
} from "./lib/model";

interface CommentRow {
  id: string;
  taskId: string;
  kind: "user" | "agent" | "system";
  authorName: string;
  presetName: string | null;
  threadId: string | null;
  body: string;
  notifiedCount: number;
  createdAt: string;
  threadTitle?: string | null;
}

interface AttachmentRow {
  id: string;
  taskId: string | null;
  commentId: string | null;
  fileName: string;
  mime: string;
  sizeBytes: number;
  isImage: boolean;
  createdAt: string;
}

interface TaskRow {
  id: string;
  projectId: string;
  number: number;
  key: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  parentTaskId: string | null;
  labelIds: string[];
  createdAt: string;
  updatedAt: string;
  threadCount?: number;
  workingThreadCount?: number;
  threadTitles?: string[];
  subtaskCount?: number;
}

interface ProjectRow {
  id: string;
  name: string;
  prefix: string;
  color: string;
  folderId?: string | null;
}

interface FolderRow {
  id: string;
  name: string;
  parentFolderId?: string | null;
}

interface ThreadRow {
  id: string;
  taskId: string;
  threadId: string;
  presetName: string;
  title: string;
  liveStatus: string;
  attachedAt: string;
}

interface PullRequestRow {
  url: string;
  number: number;
  title: string;
  state: string;
  threadIds: string[];
}

interface PresetRow {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
  permissionMode?: string;
  environmentKind?: string;
  baseBranch?: string | null;
  machineId?: string | null;
  instructions?: string;
  builtin?: boolean;
}

interface LabelRow {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

interface TaskPanelProps {
  initialKey?: string;
  syncSubPath?: boolean;
}

function formatWhen(iso: string): string {
  return formatRelativeTime(iso) || iso;
}

function StatusBadge({ status }: { status: string }) {
  const key = isTaskStatus(status) ? status : null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-xs font-medium",
        key ? STATUS_TEXT_CLASS[key] : "text-muted-foreground",
      )}
    >
      <StatusIcon status={status} className="size-3.5" />
      {statusLabel(status)}
    </span>
  );
}

function ProjectDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: color || "var(--muted-foreground)" }}
    />
  );
}

function WorkingDot() {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
    />
  );
}

function SidebarNavRow({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "max-md:pointer-coarse:h-9",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ListSidebar({
  projects,
  folders,
  tasks,
  presets,
  activeAgentCount,
  projectId,
  activeOnly,
  onSelectAll,
  onSelectActive,
  onSelectProject,
  onEditPreset,
  onNewPreset,
  onNewProject,
  onNewTask,
}: {
  projects: ProjectRow[];
  folders: FolderRow[];
  tasks: TaskRow[];
  presets: PresetRow[];
  activeAgentCount: number;
  projectId: string;
  activeOnly: boolean;
  onSelectAll: () => void;
  onSelectActive: () => void;
  onSelectProject: (id: string) => void;
  onEditPreset: (preset: PresetRow) => void;
  onNewPreset: () => void;
  onNewProject: () => void;
  onNewTask: () => void;
}) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const allActive = !activeOnly && !projectId;
  const countByProject = useMemo(() => {
    const counts = new Map<string, { total: number; working: number }>();
    for (const task of tasks) {
      const entry = counts.get(task.projectId) ?? { total: 0, working: 0 };
      entry.total += 1;
      if ((task.workingThreadCount ?? 0) > 0) entry.working += 1;
      counts.set(task.projectId, entry);
    }
    return counts;
  }, [tasks]);
  const workingTopLevel = useMemo(
    () => tasks.filter((task) => (task.workingThreadCount ?? 0) > 0).length,
    [tasks],
  );
  const ungrouped = projects.filter((project) => !project.folderId);
  const rootFolders = folders.filter((folder) => !folder.parentFolderId);
  const childFolders = folders.filter((folder) => folder.parentFolderId);

  const toggleFolder = (id: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderProject = (project: ProjectRow) => {
    const summary = countByProject.get(project.id);
    return (
      <SidebarNavRow
        key={project.id}
        active={!activeOnly && projectId === project.id}
        title={project.name}
        onClick={() => onSelectProject(project.id)}
      >
        <ProjectDot color={project.color} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {summary && summary.working > 0 ? <WorkingDot /> : null}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {summary?.total ?? 0}
        </span>
      </SidebarNavRow>
    );
  };

  const renderFolder = (folder: FolderRow, indent: boolean) => {
    const collapsed = collapsedFolders.has(folder.id);
    const folderProjects = projects.filter(
      (project) => project.folderId === folder.id,
    );
    const children = childFolders.filter(
      (child) => child.parentFolderId === folder.id,
    );
    return (
      <div key={folder.id} className={indent ? "pl-3" : undefined}>
        <button
          type="button"
          onClick={() => toggleFolder(folder.id)}
          aria-expanded={!collapsed}
          className="mt-3.5 flex w-full items-center gap-1 rounded-md px-2 pb-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          <Icon
            name="ChevronDown"
            className={cn("size-3 transition-transform", collapsed && "-rotate-90")}
          />
          {folder.name}
        </button>
        {!collapsed ? (
          <div className="space-y-px">
            {folderProjects.map(renderProject)}
            {!indent ? children.map((child) => renderFolder(child, true)) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2 space-y-px">
        <SidebarNavRow active={allActive} onClick={onSelectAll}>
          <Icon name="ListView" className="size-3.5 shrink-0" />
          <span className="flex-1">All tasks</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {tasks.length}
          </span>
        </SidebarNavRow>
        <SidebarNavRow active={activeOnly} onClick={onSelectActive}>
          <Icon name="Zap" className="size-3.5 shrink-0" />
          <span className="flex-1">Active</span>
          {activeAgentCount > 0 ? <WorkingDot /> : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {activeAgentCount || workingTopLevel}
          </span>
        </SidebarNavRow>

        {projects.length > 0 ? (
          <div className="mt-1.5">
            <SidebarNavRow title="New task" onClick={onNewTask}>
              <Icon name="Plus" className="size-3.5 shrink-0" />
              <span className="flex-1">New task</span>
            </SidebarNavRow>
          </div>
        ) : null}

        {ungrouped.length > 0 ? (
          <>
            <div className="mt-3.5 px-2 pb-1 text-xs font-semibold text-muted-foreground">
              Projects
            </div>
            {ungrouped.map(renderProject)}
          </>
        ) : null}
        {rootFolders.map((folder) => renderFolder(folder, false))}
        {projects.length > 0 ? (
          <div className="mt-1.5">
            <SidebarNavRow title="New project" onClick={onNewProject}>
              <Icon name="Plus" className="size-3.5 shrink-0" />
              <span className="flex-1">New project</span>
            </SidebarNavRow>
          </div>
        ) : null}

        <div className="mt-3.5 px-2 pb-1 text-xs font-semibold text-muted-foreground">
          Agent presets
        </div>
        {presets.map((preset) => (
          <SidebarNavRow
            key={preset.id}
            title={`Edit preset ${preset.name}`}
            onClick={() => onEditPreset(preset)}
          >
            <Icon name="Brain" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{preset.name}</span>
            {preset.environmentKind === "new-worktree" ? (
              <span
                aria-label="Spawns a new worktree"
                title="Spawns a new worktree"
                className="flex shrink-0 text-muted-foreground/70"
              >
                <Icon name="GitBranch" className="size-3" />
              </span>
            ) : null}
          </SidebarNavRow>
        ))}
        {presets.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            No presets yet.
          </div>
        ) : null}
        <SidebarNavRow title="New preset" onClick={onNewPreset}>
          <Icon name="Plus" className="size-3.5 shrink-0" />
          <span className="flex-1">New preset</span>
        </SidebarNavRow>
      </nav>
    </div>
  );
}

const CUSTOM_PRESET_VALUE = "__custom__";
const DEFAULT_MACHINE_VALUE = "__default-machine__";
const PRESET_SELECT_CLASS =
  "h-8 w-full cursor-pointer rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

type PresetDraft = {
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: PresetReasoningLevel;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string;
  machineId: string;
  instructions: string;
};

const EMPTY_PRESET_DRAFT: PresetDraft = {
  name: "",
  providerId: "",
  modelId: "",
  reasoningLevel: "medium",
  permissionMode: "auto",
  environmentKind: "project-default",
  baseBranch: "",
  machineId: "",
  instructions: "",
};

function presetDraftFromRow(preset: PresetRow): PresetDraft {
  const reasoning = preset.reasoningLevel ?? "";
  const permission = preset.permissionMode ?? "";
  const environment = preset.environmentKind ?? "";
  return {
    name: preset.name,
    providerId: preset.providerId,
    modelId: preset.modelId,
    reasoningLevel: isPresetReasoningLevel(reasoning) ? reasoning : "medium",
    permissionMode: isPresetPermissionMode(permission) ? permission : "auto",
    environmentKind: isPresetEnvironmentKind(environment)
      ? environment
      : "project-default",
    baseBranch: preset.baseBranch ?? "",
    machineId: preset.machineId ?? "",
    instructions: preset.instructions ?? "",
  };
}

function defaultPermissionMode(
  modes: PresetPermissionMode[],
): PresetPermissionMode {
  return modes.includes("auto") ? "auto" : (modes[0] ?? "full");
}

function PresetField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function PresetDialog({
  open,
  editing,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  editing: PresetRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (preset: PresetRow) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<PresetDraft>(
    editing ? presetDraftFromRow(editing) : EMPTY_PRESET_DRAFT,
  );
  const [providerCustom, setProviderCustom] = useState(false);
  const [modelCustom, setModelCustom] = useState(false);
  const [providers, setProviders] = useState<
    { id: string; name: string; supportedPermissionModes: string[] }[]
  >([]);
  const [models, setModels] = useState<
    { id: string; name: string; isDefault: boolean }[] | null
  >(null);
  const [reasoningLevels, setReasoningLevels] = useState<string[]>([]);
  const [machines, setMachines] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const modelsResolvedOnceRef = useRef(false);
  const providerResolvedRef = useRef(false);

  const setField = <K extends keyof PresetDraft>(key: K, value: PresetDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("listProviders", null)
      .then((result) => {
        if (cancelled) return;
        setProviders(result.providers);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    void rpc
      .call("listMachines", null)
      .then((result) => {
        if (!cancelled) setMachines(result.machines);
      })
      .catch(() => {
        if (!cancelled) setMachines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => {
    if (providers.length === 0 || providerResolvedRef.current) return;
    providerResolvedRef.current = true;
    const known = providers.some((provider) => provider.id === draft.providerId);
    if (draft.providerId === "") {
      const first = providers[0];
      if (first) setField("providerId", first.id);
      else setProviderCustom(true);
    } else if (!known) {
      setProviderCustom(true);
      setModelCustom(true);
    }
  }, [draft.providerId, providers]);

  const providerForModels =
    !providerCustom && draft.providerId !== "" ? draft.providerId : null;

  useEffect(() => {
    if (!providerForModels) {
      setModels(null);
      setReasoningLevels([]);
      return;
    }
    let cancelled = false;
    setModels(null);
    void rpc
      .call("listProviderModels", { providerId: providerForModels })
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setReasoningLevels(result.reasoningLevels);
      })
      .catch(() => {
        if (cancelled) return;
        setModels([]);
        setReasoningLevels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [providerForModels, rpc]);

  useEffect(() => {
    if (modelCustom || models == null) return;
    if (models.some((model) => model.id === draft.modelId)) {
      modelsResolvedOnceRef.current = true;
      return;
    }
    if (editing && draft.modelId !== "" && !modelsResolvedOnceRef.current) {
      modelsResolvedOnceRef.current = true;
      setModelCustom(true);
      return;
    }
    modelsResolvedOnceRef.current = true;
    const fallback = models.find((model) => model.isDefault) ?? models[0];
    setField("modelId", fallback ? fallback.id : "");
  }, [draft.modelId, editing, modelCustom, models]);

  const providerPermissionModes =
    !providerCustom && draft.providerId !== ""
      ? (providers
          .find((provider) => provider.id === draft.providerId)
          ?.supportedPermissionModes.filter(isPresetPermissionMode) ?? [])
      : [];
  const permissionOptions = providerCustom
    ? [...PRESET_PERMISSION_MODES]
    : providerPermissionModes;
  const serverLevels = reasoningLevels.filter(isPresetReasoningLevel);
  const reasoningOptions =
    !modelCustom && !providerCustom && serverLevels.length > 0
      ? serverLevels
      : [...PRESET_REASONING_LEVELS];

  const reasoningKey = reasoningOptions.join(",");
  const permissionKey = permissionOptions.join(",");

  useEffect(() => {
    if (!reasoningOptions.includes(draft.reasoningLevel)) {
      setField(
        "reasoningLevel",
        reasoningOptions.includes("medium")
          ? "medium"
          : (reasoningOptions[0] ?? "medium"),
      );
    }
  }, [draft.reasoningLevel, reasoningKey]);

  useEffect(() => {
    if (permissionOptions.length === 0) return;
    if (!permissionOptions.includes(draft.permissionMode)) {
      setField("permissionMode", defaultPermissionMode(permissionOptions));
    }
  }, [draft.permissionMode, permissionKey]);

  const canSubmit =
    draft.name.trim() !== "" &&
    draft.providerId.trim() !== "" &&
    draft.modelId.trim() !== "" &&
    !submitting;

  const save = async () => {
    setSubmitting(true);
    setError(null);
    const fields = {
      name: draft.name.trim(),
      providerId: draft.providerId.trim(),
      modelId: draft.modelId.trim(),
      reasoningLevel: draft.reasoningLevel,
      permissionMode: draft.permissionMode,
      environmentKind: draft.environmentKind,
      baseBranch:
        draft.environmentKind === "new-worktree" && draft.baseBranch.trim()
          ? draft.baseBranch.trim()
          : null,
      machineId:
        draft.environmentKind === "new-worktree" && draft.machineId.trim()
          ? draft.machineId.trim()
          : null,
      instructions: draft.instructions,
    };
    try {
      const result = editing
        ? await rpc.call("updatePreset", { presetId: editing.id, ...fields })
        : await rpc.call("createPreset", fields);
      if (!result.ok || !result.preset) {
        throw new Error(result.error ?? "Failed to save preset.");
      }
      onSaved(result.preset);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit preset" : "New preset"}</DialogTitle>
          <DialogDescription>
            Presets pick the provider, model, and guardrails for dispatched
            threads.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <PresetField label="Name">
            <Input
              autoFocus
              value={draft.name}
              placeholder="e.g. Sonnet · high"
              onChange={(event) => setField("name", event.target.value)}
              className="h-8"
            />
          </PresetField>
          <div className="grid grid-cols-2 gap-3">
            <PresetField label="Provider">
              <select
                aria-label="Provider"
                className={PRESET_SELECT_CLASS}
                value={providerCustom ? CUSTOM_PRESET_VALUE : draft.providerId}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === CUSTOM_PRESET_VALUE) {
                    setProviderCustom(true);
                    setModelCustom(true);
                    setField("permissionMode", "full");
                    return;
                  }
                  setProviderCustom(false);
                  setModelCustom(false);
                  modelsResolvedOnceRef.current = false;
                  setDraft((current) => ({
                    ...current,
                    providerId: value,
                    modelId: "",
                  }));
                }}
              >
                {providers.length === 0 ? (
                  <option value={draft.providerId || ""}>
                    {draft.providerId ? draft.providerId : "Loading…"}
                  </option>
                ) : null}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
                <option value={CUSTOM_PRESET_VALUE}>Custom…</option>
              </select>
              {providerCustom ? (
                <Input
                  value={draft.providerId}
                  placeholder="provider id, e.g. claude-code"
                  aria-label="Custom provider id"
                  onChange={(event) => setField("providerId", event.target.value)}
                  className="mt-1 h-8"
                />
              ) : null}
            </PresetField>
            <PresetField label="Model">
              {providerCustom || modelCustom ? (
                <>
                  {!providerCustom ? (
                    <select
                      aria-label="Model"
                      className={PRESET_SELECT_CLASS}
                      value={CUSTOM_PRESET_VALUE}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === CUSTOM_PRESET_VALUE) return;
                        setModelCustom(false);
                        setField("modelId", value);
                      }}
                    >
                      {(models ?? []).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                      <option value={CUSTOM_PRESET_VALUE}>Custom…</option>
                    </select>
                  ) : null}
                  <Input
                    value={draft.modelId}
                    placeholder="model id, e.g. claude-sonnet-5"
                    aria-label="Custom model id"
                    onChange={(event) => setField("modelId", event.target.value)}
                    className={cn("h-8", !providerCustom && "mt-1")}
                  />
                </>
              ) : (
                <select
                  aria-label="Model"
                  className={PRESET_SELECT_CLASS}
                  value={draft.modelId}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === CUSTOM_PRESET_VALUE) {
                      setModelCustom(true);
                      return;
                    }
                    setField("modelId", value);
                  }}
                >
                  {draft.modelId === "" ? (
                    <option value="">
                      {models == null ? "Loading…" : "Model"}
                    </option>
                  ) : null}
                  {(models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                      {model.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                  <option value={CUSTOM_PRESET_VALUE}>Custom…</option>
                </select>
              )}
            </PresetField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PresetField label="Reasoning">
              <select
                aria-label="Reasoning"
                className={PRESET_SELECT_CLASS}
                value={draft.reasoningLevel}
                onChange={(event) => {
                  if (isPresetReasoningLevel(event.target.value)) {
                    setField("reasoningLevel", event.target.value);
                  }
                }}
              >
                {reasoningOptions.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </PresetField>
            <PresetField label="Permissions">
              <select
                aria-label="Permissions"
                className={PRESET_SELECT_CLASS}
                value={draft.permissionMode}
                onChange={(event) => {
                  if (isPresetPermissionMode(event.target.value)) {
                    setField("permissionMode", event.target.value);
                  }
                }}
              >
                {(permissionOptions.length > 0
                  ? permissionOptions
                  : PRESET_PERMISSION_MODES
                ).map((mode) => (
                  <option key={mode} value={mode}>
                    {PRESET_PERMISSION_LABELS[mode]}
                  </option>
                ))}
              </select>
            </PresetField>
          </div>
          <PresetField label="Execution environment">
            <select
              aria-label="Execution environment"
              className={PRESET_SELECT_CLASS}
              value={draft.environmentKind}
              onChange={(event) => {
                if (!isPresetEnvironmentKind(event.target.value)) return;
                const kind = event.target.value;
                setDraft((current) => ({
                  ...current,
                  environmentKind: kind,
                  ...(kind === "new-worktree"
                    ? {}
                    : { baseBranch: "", machineId: "" }),
                }));
              }}
            >
              {PRESET_ENVIRONMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {PRESET_ENVIRONMENT_LABELS[kind]}
                </option>
              ))}
            </select>
          </PresetField>
          {draft.environmentKind === "new-worktree" ? (
            <div className="grid grid-cols-2 gap-3">
              <PresetField label="Base branch">
                <Input
                  value={draft.baseBranch}
                  placeholder="project default base — leave empty"
                  aria-label="Base branch"
                  onChange={(event) => setField("baseBranch", event.target.value)}
                  className="h-8"
                />
              </PresetField>
              <PresetField label="Machine">
                <select
                  aria-label="Machine"
                  className={PRESET_SELECT_CLASS}
                  value={draft.machineId === "" ? DEFAULT_MACHINE_VALUE : draft.machineId}
                  onChange={(event) =>
                    setField(
                      "machineId",
                      event.target.value === DEFAULT_MACHINE_VALUE
                        ? ""
                        : event.target.value,
                    )
                  }
                >
                  <option value={DEFAULT_MACHINE_VALUE}>Default machine</option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                      {machine.name}
                    </option>
                  ))}
                  {draft.machineId !== "" &&
                  !machines.some((machine) => machine.id === draft.machineId) ? (
                    <option value={draft.machineId}>{draft.machineId}</option>
                  ) : null}
                </select>
              </PresetField>
            </div>
          ) : null}
          <PresetField label="Instructions">
            <textarea
              value={draft.instructions}
              placeholder="Extra instructions prepended to dispatched threads"
              onChange={(event) => setField("instructions", event.target.value)}
              className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </PresetField>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={() => void save()}
          >
            {submitting
              ? "Saving…"
              : editing
                ? "Save preset"
                : "Create preset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NO_FOLDER = "__none__";
const NEW_FOLDER = "__new__";
const NO_BB_LINK = "__none__";

function ProjectField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Color"
      className="flex flex-wrap gap-1.5"
    >
      {PROJECT_COLOR_PALETTE.map((swatch) => (
        <button
          key={swatch.value}
          type="button"
          role="radio"
          aria-checked={value === swatch.value}
          aria-label={swatch.label}
          title={swatch.label}
          onClick={() => onChange(swatch.value)}
          className={cn(
            "size-5 rounded-md",
            value === swatch.value &&
              "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
          style={{ backgroundColor: swatch.value }}
        />
      ))}
    </div>
  );
}

function ProjectDialog({
  open,
  projects,
  folders,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  projects: ProjectRow[];
  folders: FolderRow[];
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectRow) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [linkedBbProjectId, setLinkedBbProjectId] = useState<string | null>(
    null,
  );
  const [bbProjects, setBbProjects] = useState<
    { id: string; name: string }[]
  >([]);
  const [folderList, setFolderList] = useState(folders);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset only when the dialog opens. Board polling replaces `folders` with a
  // new array every few seconds — that must not wipe an in-progress draft.
  useEffect(() => {
    if (!open) return;
    setName("");
    setPrefix("");
    setPrefixTouched(false);
    setColor(DEFAULT_PROJECT_COLOR);
    setFolderId(null);
    setNewFolderMode(false);
    setNewFolderName("");
    setLinkedBbProjectId(null);
    setError(null);
    setFolderList(folders);
    void rpc
      .call("listBbProjects", null)
      .then((result) => {
        if (result.available) setBbProjects(result.bbProjects);
      })
      .catch(() => setBbProjects([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-only reset
  }, [open, rpc]);

  useEffect(() => {
    if (!open) return;
    setFolderList(folders);
  }, [folders, open]);

  const prefixError = useMemo(() => {
    if (prefix === "") return null;
    if (!PROJECT_PREFIX_PATTERN.test(prefix)) {
      return "Use 1–10 uppercase letters and digits, starting with a letter.";
    }
    const clash = projects.find(
      (project) => project.prefix.toUpperCase() === prefix.toUpperCase(),
    );
    return clash ? `Already used by ${clash.name}.` : null;
  }, [prefix, projects]);

  const folderName = (id: string) => {
    const folder = folderList.find((entry) => entry.id === id);
    if (!folder) return "Folder";
    const parent = folder.parentFolderId
      ? folderList.find((entry) => entry.id === folder.parentFolderId)
      : null;
    return parent ? `${parent.name} / ${folder.name}` : folder.name;
  };

  const canSubmit =
    name.trim().length > 0 &&
    prefix.length > 0 &&
    prefixError === null &&
    !submitting;

  const createFolderInline = async () => {
    const trimmed = newFolderName.trim();
    if (trimmed === "") return;
    setError(null);
    try {
      const result = await rpc.call("createFolder", {
        name: trimmed,
        parentFolderId: null,
      });
      if (!result.ok || !result.folder) {
        throw new Error(result.error ?? "Failed to create folder.");
      }
      setFolderList((current) => [...current, result.folder]);
      setFolderId(result.folder.id);
      setNewFolderMode(false);
      setNewFolderName("");
    } catch (folderError) {
      setError(
        folderError instanceof Error
          ? folderError.message
          : String(folderError),
      );
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await rpc.call("createProject", {
        name: name.trim(),
        prefix,
        color,
        folderId,
        linkedBbProjectId,
      });
      if (!result.ok || !result.project) {
        throw new Error(
          result.error
            ? describeCreateProjectError(new Error(result.error))
            : "Failed to create project.",
        );
      }
      onCreated(result.project);
      onOpenChange(false);
    } catch (submitError) {
      setError(describeCreateProjectError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const folderSelectValue = newFolderMode
    ? NEW_FOLDER
    : (folderId ?? NO_FOLDER);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Projects group tasks under a shared key prefix.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ProjectField label="Name">
            <Input
              autoFocus
              value={name}
              placeholder="e.g. Tasks Plugin"
              onChange={(event) => {
                setName(event.target.value);
                if (!prefixTouched) {
                  setPrefix(deriveProjectPrefix(event.target.value));
                }
              }}
              className="h-8"
            />
          </ProjectField>
          <ProjectField
            label="Prefix"
            hint={
              prefixError ??
              "Task keys use this prefix, e.g. TSK-12. Uppercase, unique."
            }
          >
            <Input
              value={prefix}
              placeholder="TSK"
              aria-invalid={prefixError !== null}
              onChange={(event) => {
                setPrefixTouched(true);
                setPrefix(event.target.value.toUpperCase());
              }}
              className={
                prefixError !== null
                  ? "h-8 w-32 border-destructive focus-visible:ring-destructive"
                  : "h-8 w-32"
              }
            />
          </ProjectField>
          <ProjectField label="Color">
            <ColorSwatchPicker value={color} onChange={setColor} />
          </ProjectField>
          <ProjectField label="Folder">
            <select
              aria-label="Folder"
              value={folderSelectValue}
              onChange={(event) => {
                const value = event.target.value;
                if (value === NEW_FOLDER) {
                  setNewFolderMode(true);
                  return;
                }
                setNewFolderMode(false);
                setFolderId(value === NO_FOLDER ? null : value);
              }}
              className={PRESET_SELECT_CLASS}
            >
              <option value={NO_FOLDER}>No folder</option>
              {folderList.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folderName(folder.id)}
                </option>
              ))}
              <option value={NEW_FOLDER}>New folder…</option>
            </select>
            {newFolderMode ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <Input
                  autoFocus
                  value={newFolderName}
                  placeholder="Folder name"
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createFolderInline();
                    }
                  }}
                  className="h-7 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={newFolderName.trim() === ""}
                  onClick={() => void createFolderInline()}
                >
                  <Icon name="FolderPlus" className="size-3.5" />
                  Create
                </Button>
              </div>
            ) : null}
          </ProjectField>
          <ProjectField
            label="Linked bb project"
            hint="Optional. Linking a bb project enables dispatching to agents."
          >
            <select
              aria-label="Linked bb project"
              value={linkedBbProjectId ?? NO_BB_LINK}
              onChange={(event) => {
                const value = event.target.value;
                setLinkedBbProjectId(value === NO_BB_LINK ? null : value);
              }}
              className={PRESET_SELECT_CLASS}
            >
              <option value={NO_BB_LINK}>Not linked</option>
              {linkedBbProjectId &&
              !bbProjects.some((project) => project.id === linkedBbProjectId) ? (
                <option value={linkedBbProjectId}>
                  Unavailable · {linkedBbProjectId}
                </option>
              ) : null}
              {bbProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </ProjectField>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function pickTaskProjectId(
  projects: ProjectRow[],
  preferredId: string,
): string {
  if (preferredId && projects.some((project) => project.id === preferredId)) {
    return preferredId;
  }
  return projects[0]?.id ?? "";
}

function TaskDialog({
  open,
  projects,
  defaultProjectId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  projects: ProjectRow[];
  defaultProjectId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: TaskRow) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<TaskStatus>("backlog");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Soft-dismiss (Escape / X) may close the dialog; keep the draft unless the
  // user Cancels or Create succeeds. Outside clicks are blocked so Refresh and
  // other chrome cannot dismiss a half-filled form.
  const discardOnCloseRef = useRef(false);

  const clearDraft = useCallback(() => {
    setTitle("");
    setDescription("");
    setProjectId("");
    setStatus("backlog");
    setPriority("none");
    setDueDate("");
    setError(null);
  }, []);

  const isDirty =
    title.trim() !== "" ||
    description.trim() !== "" ||
    status !== "backlog" ||
    priority !== "none" ||
    dueDate !== "";

  useEffect(() => {
    if (!open || projectId !== "") return;
    const next = pickTaskProjectId(projects, defaultProjectId);
    if (next) setProjectId(next);
  }, [defaultProjectId, open, projectId, projects]);

  const selectedProject = projects.find((project) => project.id === projectId);
  const canSubmit =
    title.trim().length > 0 && projectId.length > 0 && !submitting;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      if (discardOnCloseRef.current) {
        discardOnCloseRef.current = false;
        clearDraft();
      }
      // Keep draft on soft dismiss so reopening restores typed input.
    }
    onOpenChange(next);
  };

  const discardAndClose = () => {
    discardOnCloseRef.current = true;
    handleOpenChange(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await rpc.call("createTask", {
        projectId,
        title: title.trim(),
        description,
        status,
        priority,
        dueDate: dueDate === "" ? null : dueDate,
      });
      if (!result.ok || !result.task) {
        throw new Error(result.error ?? "Failed to create task.");
      }
      clearDraft();
      onCreated(result.task);
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        // Refresh / sidebar / list chrome sit outside the modal. Radix treats
        // those clicks as dismiss; block that so a board refresh cannot wipe
        // an in-progress draft. Cancel and Escape still close.
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (isDirty) {
            // Soft-close: keep draft. Parent stays mounted so reopen restores.
            event.preventDefault();
            handleOpenChange(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {selectedProject ? (
              <ProjectDot color={selectedProject.color} />
            ) : null}
            New task
            {selectedProject ? (
              <span className="text-xs font-normal text-muted-foreground">
                · {selectedProject.name}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            Create a task in your tracker. You can add details and dispatch an
            agent after it is created.
          </DialogDescription>
        </DialogHeader>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create a project first, then add tasks to it.
          </p>
        ) : (
          <div className="space-y-4">
            <ProjectField label="Title">
              <Input
                autoFocus
                value={title}
                placeholder="What needs doing?"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                className="h-8"
              />
            </ProjectField>
            <ProjectField label="Description">
              <textarea
                value={description}
                placeholder="Optional details (markdown supported)"
                rows={4}
                onChange={(event) => setDescription(event.target.value)}
                className={cn(
                  "w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm",
                  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "min-h-[5rem]",
                )}
              />
            </ProjectField>
            <ProjectField label="Project">
              <select
                aria-label="Project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className={PRESET_SELECT_CLASS}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </ProjectField>
            <div className="grid grid-cols-2 gap-3">
              <ProjectField label="Status">
                <select
                  aria-label="Status"
                  value={status}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (isTaskStatus(value)) setStatus(value);
                  }}
                  className={PRESET_SELECT_CLASS}
                >
                  {TASK_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {STATUS_LABELS[value]}
                    </option>
                  ))}
                </select>
              </ProjectField>
              <ProjectField label="Priority">
                <select
                  aria-label="Priority"
                  value={priority}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (TASK_PRIORITIES.includes(value as TaskPriority)) {
                      setPriority(value as TaskPriority);
                    }
                  }}
                  className={PRESET_SELECT_CLASS}
                >
                  {TASK_PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {PRIORITY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </ProjectField>
            </div>
            <ProjectField label="Due date">
              <Input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="h-8"
              />
            </ProjectField>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={discardAndClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit || projects.length === 0}
            onClick={() => void submit()}
          >
            {submitting ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function threadStatusMeta(status: string) {
  return THREAD_STATUS_META[status] ?? THREAD_STATUS_META.idle;
}

function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest?: PullRequestRow;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state] ?? PR_STATE_META.open;
    return (
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium shadow-2xs hover:border-input"
        onClick={(event) => event.stopPropagation()}
      >
        <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />
        #{pullRequest.number}
      </a>
    );
  }
  if (unavailable) {
    return (
      <span
        title="Couldn't check this thread's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR unavailable
      </span>
    );
  }
  return null;
}

function ThreadCard({
  thread,
  pullRequest,
  pullRequestUnavailable,
  onOpen,
}: {
  thread: ThreadRow;
  pullRequest?: PullRequestRow;
  pullRequestUnavailable: boolean;
  onOpen: (threadId: string) => void;
}) {
  const meta = threadStatusMeta(thread.liveStatus);
  const attached = formatRelativeTime(thread.attachedAt);
  return (
    <div className="mb-2 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs">
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-xs font-medium",
          meta.textClassName,
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", meta.dotClassName)}
        />
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block w-full truncate text-left text-sm font-medium hover:underline"
          onClick={() => onOpen(thread.threadId)}
          title={thread.title || thread.threadId}
        >
          {thread.title || thread.threadId}
        </button>
        <div className="text-xs text-muted-foreground">
          {thread.presetName || "Agent"}
          {attached ? ` · attached ${attached}` : ""}
        </div>
      </div>
      <ThreadPullRequestPill
        pullRequest={pullRequest}
        unavailable={pullRequestUnavailable}
      />
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current"
        onClick={() => onOpen(thread.threadId)}
      >
        Open thread
        <Icon name="ArrowUpRight" className="size-3" />
      </button>
    </div>
  );
}

function CommentAuthor({
  comment,
  threads,
  onOpenThread,
}: {
  comment: CommentRow;
  threads: ThreadRow[];
  onOpenThread: (threadId: string) => void;
}) {
  if (comment.kind === "agent" && comment.threadId) {
    const title =
      comment.threadTitle ??
      threads.find((thread) => thread.threadId === comment.threadId)?.title ??
      comment.authorName;
    return (
      <button
        type="button"
        onClick={() => onOpenThread(comment.threadId!)}
        className="truncate font-semibold text-primary hover:underline"
        title={title}
      >
        {title}
      </button>
    );
  }
  return <span className="font-semibold">{comment.authorName}</span>;
}

const selectClass = cn(
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

function LabelChip({
  label,
  selected,
  onToggle,
}: {
  label: LabelRow;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const interactive = Boolean(onToggle);
  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        selected
          ? "border-foreground/40 bg-foreground/10 text-foreground"
          : "border-border text-muted-foreground",
        interactive && "hover:bg-state-hover",
        !interactive && "cursor-default",
      )}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ background: label.color || "currentColor" }}
      />
      {label.name}
    </button>
  );
}

const COLLAPSED_PROJECTS_KEY = "task-comment-float:collapsed-projects";
const COLLAPSED_STATUSES_KEY = "task-comment-float:collapsed-statuses";
const GROUP_BY_KEY = "task-comment-float:group-by";
const PRESET_STORAGE_KEY = "task-comment-float:preset-id";
const SIDEBAR_COLLAPSED_KEY = "task-comment-float:sidebar-collapsed";
const BROWSE_SCOPE_KEY = "task-comment-float:browse-scope";
const BROWSE_SCOPE_EVENT = "tcf-browse-scope";

type ListGroupBy = "status" | "project";

type BrowseScope = {
  projectId: string;
  activeOnly: boolean;
};

function readGroupBy(): ListGroupBy {
  try {
    const raw = window.localStorage.getItem(GROUP_BY_KEY);
    return raw === "project" ? "project" : "status";
  } catch {
    return "status";
  }
}

function writeGroupBy(value: ListGroupBy): void {
  try {
    window.localStorage.setItem(GROUP_BY_KEY, value);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function readBrowseScope(): BrowseScope {
  try {
    const raw = window.localStorage.getItem(BROWSE_SCOPE_KEY);
    if (!raw) return { projectId: "", activeOnly: false };
    const parsed = JSON.parse(raw) as Partial<BrowseScope>;
    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      activeOnly: parsed.activeOnly === true,
    };
  } catch {
    return { projectId: "", activeOnly: false };
  }
}

function writeBrowseScope(scope: BrowseScope): void {
  try {
    window.localStorage.setItem(BROWSE_SCOPE_KEY, JSON.stringify(scope));
    window.dispatchEvent(new Event(BROWSE_SCOPE_EVENT));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

/** Shared All / Active / project filter between the Navigation fixed tab and main list. */
function useBrowseScope(): readonly [
  BrowseScope,
  (scope: BrowseScope) => void,
] {
  const [scope, setScopeState] = useState(readBrowseScope);
  useEffect(() => {
    const sync = () => setScopeState(readBrowseScope());
    window.addEventListener("storage", sync);
    window.addEventListener(BROWSE_SCOPE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(BROWSE_SCOPE_EVENT, sync);
    };
  }, []);
  const setScope = useCallback((next: BrowseScope) => {
    writeBrowseScope(next);
    setScopeState(next);
  }, []);
  return [scope, setScope] as const;
}

function readStoredPresetId(): string {
  try {
    return window.localStorage.getItem(PRESET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredPresetId(id: string): void {
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, id);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function pickDefaultPresetId(presets: PresetRow[], preferredId = ""): string {
  if (preferredId && presets.some((preset) => preset.id === preferredId)) {
    return preferredId;
  }
  const stored = readStoredPresetId();
  if (stored && presets.some((preset) => preset.id === stored)) return stored;
  const named = presets.find((preset) => preset.name === DEFAULT_PRESET_NAME);
  return named?.id ?? presets[0]?.id ?? "";
}

function readCollapsedProjects(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedProjects(ids: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function readCollapsedStatuses(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STATUSES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedStatuses(ids: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_STATUSES_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function TaskRowItem({
  task,
  project,
  labels,
  showProject,
  showStatusBadge,
  onOpen,
}: {
  task: TaskRow;
  project?: ProjectRow;
  labels: LabelRow[];
  showProject: boolean;
  showStatusBadge: boolean;
  onOpen: (key: string) => void;
}) {
  const threadCount = task.threadCount ?? 0;
  const working = task.workingThreadCount ?? 0;
  const subtasks = task.subtaskCount ?? 0;
  return (
    <li className="border-t border-border first:border-t-0">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-state-hover"
        onClick={() => onOpen(task.key)}
      >
        <StatusIcon status={task.status} className="mt-0.5 size-4" />
        <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
          {task.key}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm">{task.title}</span>
            {working > 0 ? <WorkingDot /> : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {showProject && project ? (
              <span className="inline-flex items-center gap-1">
                <ProjectDot color={project.color} />
                {project.name}
              </span>
            ) : null}
            {task.priority !== "none" ? (
              <span>{priorityLabel(task.priority)}</span>
            ) : null}
            {task.dueDate ? <span>due {task.dueDate}</span> : null}
            {threadCount > 0 ? (
              <span>
                {threadCount} thread{threadCount === 1 ? "" : "s"}
                {working > 0 ? ` · ${working} working` : ""}
              </span>
            ) : (
              <span>no threads</span>
            )}
            {subtasks > 0 ? (
              <span>
                {subtasks} subtask{subtasks === 1 ? "" : "s"}
              </span>
            ) : null}
            {labels.map((label) => (
              <LabelChip key={label.id} label={label} />
            ))}
          </span>
        </span>
        {showStatusBadge ? <StatusBadge status={task.status} /> : null}
      </button>
    </li>
  );
}

function GroupHeader({
  expanded,
  onToggle,
  children,
  count,
  working,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  count: number;
  working: boolean;
}) {
  return (
    <h2>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-medium hover:bg-state-hover"
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-0 shrink-0 border-y-[5px] border-l-[6px] border-y-transparent border-l-current transition-transform",
            expanded && "rotate-90",
          )}
        />
        {children}
        {working ? <WorkingDot /> : null}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      </button>
    </h2>
  );
}

function TaskList({
  query,
  onQueryChange,
  projectId,
  onProjectChange,
  activeOnly,
  onActiveOnlyChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  projects,
  folders,
  tasks,
  labels,
  loading,
  error,
  onOpen,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  projectId: string;
  onProjectChange: (value: string) => void;
  activeOnly: boolean;
  onActiveOnlyChange: (value: boolean) => void;
  filters: ListFilters;
  onFiltersChange: (value: ListFilters) => void;
  sort: TaskSort;
  onSortChange: (value: TaskSort) => void;
  projects: ProjectRow[];
  folders: FolderRow[];
  tasks: TaskRow[];
  labels: LabelRow[];
  loading: boolean;
  error: string | null;
  onOpen: (key: string) => void;
}) {
  const labelById = useMemo(
    () => new Map(labels.map((label) => [label.id, label])),
    [labels],
  );
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const [groupBy, setGroupBy] = useState<ListGroupBy>(readGroupBy);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    readCollapsedProjects,
  );
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<string>>(
    readCollapsedStatuses,
  );
  const searching = query.trim().length > 0;
  const labelOptions = useMemo(
    () => labelFilterOptions(labels),
    [labels],
  );
  const filteredEmpty = !loading && tasks.length === 0 && !error;
  const filtersActive = hasActiveFilters(filters);

  const setGroup = (next: ListGroupBy) => {
    setGroupBy(next);
    writeGroupBy(next);
  };

  const toggleProject = useCallback((id: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedProjects(next);
      return next;
    });
  }, []);

  const toggleStatus = useCallback((id: string) => {
    setCollapsedStatuses((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedStatuses(next);
      return next;
    });
  }, []);

  const projectFolders = useMemo(() => {
    const used = new Set(tasks.map((task) => task.projectId));
    const listed = projects.filter(
      (project) => used.has(project.id) || !projectId || project.id === projectId,
    );
    const knownIds = new Set(listed.map((project) => project.id));
    const orphans = [...used]
      .filter((id) => !knownIds.has(id))
      .map((id) => ({
        id,
        name: id,
        prefix: "",
        color: "slategray",
        folderId: null as string | null,
      }));
    return [...listed, ...orphans];
  }, [projectId, projects, tasks]);

  const statusGroups = useMemo(() => {
    const known = new Set<string>(TASK_STATUSES);
    const extra = [
      ...new Set(
        tasks.map((task) => task.status).filter((status) => !known.has(status)),
      ),
    ];
    return [...TASK_STATUSES, ...extra].map((status) => ({
      status,
      tasks: tasks.filter((task) => task.status === status),
    }));
  }, [tasks]);

  const renderTask = (task: TaskRow) => {
    const taskLabels = (task.labelIds ?? [])
      .map((id) => labelById.get(id))
      .filter((row): row is LabelRow => Boolean(row));
    return (
      <TaskRowItem
        key={task.id}
        task={task}
        project={projectById.get(task.projectId)}
        labels={taskLabels}
        showProject={groupBy === "status"}
        showStatusBadge={groupBy === "project"}
        onOpen={onOpen}
      />
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5 md:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search tasks"
          aria-label="Search tasks"
          className="min-w-[12rem] flex-1"
        />
        <div
          role="group"
          aria-label="Group tasks"
          className="flex shrink-0 rounded-md border border-input p-0.5"
        >
          {(
            [
              ["status", "By status"],
              ["project", "By project"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={groupBy === value}
              onClick={() => setGroup(value)}
              className={cn(
                "h-7 rounded-sm px-2 text-xs",
                groupBy === value
                  ? "bg-foreground/10 font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          className={cn(selectClass, "md:hidden")}
          value={activeOnly ? "active" : projectId}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "active") {
              onActiveOnlyChange(true);
              onProjectChange("");
              return;
            }
            onActiveOnlyChange(false);
            onProjectChange(next);
          }}
          aria-label="List scope"
        >
          <option value="">All tasks</option>
          <option value="active">Active</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.prefix} · {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="-mx-4 md:-mx-5">
        <ListFilterBar
          filters={filters}
          onChange={onFiltersChange}
          sort={sort}
          onSortChange={onSortChange}
          labelOptions={labelOptions}
          taskCount={tasks.length}
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {loading && tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading tasks…</p>
      ) : null}

      {filteredEmpty ? (
        filtersActive ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No tasks match these filters
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onFiltersChange(EMPTY_FILTERS)}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No tasks match.</p>
        )
      ) : null}

      {groupBy === "status"
        ? statusGroups.map((group) => {
            if (group.tasks.length === 0) return null;
            const expanded = searching || !collapsedStatuses.has(group.status);
            const workingInGroup = group.tasks.some(
              (item) => (item.workingThreadCount ?? 0) > 0,
            );
            return (
              <section key={group.status} className="space-y-1">
                <GroupHeader
                  expanded={expanded}
                  onToggle={() => toggleStatus(group.status)}
                  count={group.tasks.length}
                  working={workingInGroup}
                >
                  <StatusIcon status={group.status} className="size-3.5" />
                  <span className="min-w-0 truncate">
                    {statusLabel(group.status)}
                  </span>
                </GroupHeader>
                {expanded ? (
                  <ul className="overflow-hidden rounded-md border border-border">
                    {group.tasks.map(renderTask)}
                  </ul>
                ) : null}
              </section>
            );
          })
        : projectFolders.map((project) => {
            const folderTasks = tasks.filter(
              (task) => task.projectId === project.id,
            );
            if (folderTasks.length === 0) return null;
            const parentFolder = project.folderId
              ? folderById.get(project.folderId)
              : undefined;
            const expanded = searching || !collapsedProjects.has(project.id);
            const workingInFolder = folderTasks.some(
              (item) => (item.workingThreadCount ?? 0) > 0,
            );
            return (
              <section key={project.id} className="space-y-1">
                <GroupHeader
                  expanded={expanded}
                  onToggle={() => toggleProject(project.id)}
                  count={folderTasks.length}
                  working={workingInFolder}
                >
                  <ProjectDot color={project.color} />
                  <span className="min-w-0 truncate">{project.name}</span>
                  {parentFolder && parentFolder.name !== project.name ? (
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {parentFolder.name}
                    </span>
                  ) : null}
                </GroupHeader>
                {expanded ? (
                  <ul className="overflow-hidden rounded-md border border-border">
                    {folderTasks.map(renderTask)}
                  </ul>
                ) : null}
              </section>
            );
          })}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
      {label}
      <select
        className={cn(selectClass, "h-8 w-full capitalize")}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const RAIL_ROW_CLASS =
  "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-state-hover";

function PropertiesRail({
  task,
  project,
  labels,
  threads,
  presets,
  presetId,
  onPresetChange,
  onDispatch,
  dispatching,
  saving,
  onUpdate,
  onToggleLabel,
  onOpenThread,
}: {
  task: TaskRow;
  project: ProjectRow | null;
  labels: LabelRow[];
  threads: ThreadRow[];
  presets: PresetRow[];
  presetId: string;
  onPresetChange: (id: string) => void;
  onDispatch: () => void;
  dispatching: boolean;
  saving: boolean;
  onUpdate: (patch: {
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDate?: string | null;
  }) => void;
  onToggleLabel: (labelId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const active = threads.filter(
    (thread) =>
      thread.liveStatus === "working" || thread.liveStatus === "starting",
  );
  const railSelect = cn(
    "min-w-0 flex-1 cursor-pointer bg-transparent text-sm",
    "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  );

  return (
    <aside className="hidden w-56 shrink-0 overflow-y-auto border-l border-border px-3 py-5 md:block">
      <h2 className="mb-1.5 text-xs font-semibold text-muted-foreground">
        Properties
      </h2>
      <label className={RAIL_ROW_CLASS}>
        <StatusIcon status={task.status} className="size-3.5" />
        <select
          aria-label="Status"
          className={railSelect}
          value={task.status}
          disabled={saving}
          onChange={(event) =>
            onUpdate({ status: event.target.value as TaskStatus })
          }
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <label className={RAIL_ROW_CLASS}>
        <Icon name="ArrowUpDown" className="size-3.5 shrink-0 text-muted-foreground" />
        <select
          aria-label="Priority"
          className={railSelect}
          value={task.priority}
          disabled={saving}
          onChange={(event) =>
            onUpdate({ priority: event.target.value as TaskPriority })
          }
        >
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </select>
      </label>
      <label className={RAIL_ROW_CLASS}>
        <Icon name="Clock" className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="date"
          aria-label="Due date"
          className={cn(railSelect, "text-sm")}
          value={task.dueDate ?? ""}
          disabled={saving}
          onChange={(event) =>
            onUpdate({
              dueDate: event.target.value ? event.target.value : null,
            })
          }
        />
      </label>

      <div className="mb-1 mt-3 text-[11px] font-semibold text-muted-foreground">
        Labels
      </div>
      <div className="flex flex-wrap items-center gap-1 py-0.5">
        {labels.length === 0 ? (
          <span className="text-xs text-muted-foreground">No labels</span>
        ) : (
          labels.map((label) => (
            <LabelChip
              key={label.id}
              label={label}
              selected={task.labelIds.includes(label.id)}
              onToggle={() => onToggleLabel(label.id)}
            />
          ))
        )}
      </div>

      <div className="mb-1 mt-3 text-[11px] font-semibold text-muted-foreground">
        Project
      </div>
      <div className="flex items-center gap-2 py-0.5 text-sm">
        <ProjectDot color={project?.color ?? ""} />
        <span className="truncate">{project?.name ?? "…"}</span>
      </div>

      <div className="mb-1 mt-3 text-[11px] font-semibold text-muted-foreground">
        Dispatch
      </div>
      <div className="flex flex-col gap-1.5 py-0.5">
        <select
          aria-label="Agent preset"
          className={cn(selectClass, "h-8 w-full")}
          value={presetId}
          onChange={(event) => onPresetChange(event.target.value)}
          disabled={dispatching || presets.length === 0}
        >
          {presets.length === 0 ? (
            <option value="">No presets</option>
          ) : (
            presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))
          )}
        </select>
        <Button
          type="button"
          size="sm"
          className="w-full"
          onClick={onDispatch}
          disabled={!presetId || dispatching || saving}
        >
          {dispatching ? "Spinning…" : "Spin agent"}
        </Button>
      </div>

      <div className="mb-1 mt-3 text-[11px] font-semibold text-muted-foreground">
        Agents
      </div>
      <div className="flex flex-col gap-1 py-0.5 text-xs">
        {active.length > 0 ? (
          active.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className="flex items-center gap-1.5 text-left font-medium text-success hover:underline"
              onClick={() => onOpenThread(thread.threadId)}
              title={thread.title || thread.threadId}
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
              />
              <span className="min-w-0 truncate">
                {thread.presetName || "Agent"}{" "}
                {thread.liveStatus === "starting" ? "starting" : "working"}
              </span>
            </button>
          ))
        ) : (
          <span className="text-muted-foreground">none active</span>
        )}
      </div>
    </aside>
  );
}

function TaskCommentPanel({
  initialKey = "",
  syncSubPath = false,
}: TaskPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [task, setTask] = useState<TaskRow | null>(null);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [labels, setLabels] = useState<LabelRow[]>([]);
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequestRow[]>([]);
  const [unavailableThreadIds, setUnavailableThreadIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [boardQuery, setBoardQuery] = useState("");
  const [browseScope, setBrowseScope] = useBrowseScope();
  const boardProjectId = browseScope.projectId;
  const activeOnly = browseScope.activeOnly;
  const listScope = listPreferenceScope(boardProjectId, activeOnly);
  const [listPref, setListPref] = useState<ListPreference>(() =>
    loadListPreference(listScope),
  );
  const [boardProjects, setBoardProjects] = useState<ProjectRow[]>([]);
  const [boardFolders, setBoardFolders] = useState<FolderRow[]>([]);
  const [boardTasks, setBoardTasks] = useState<TaskRow[]>([]);
  const [boardLabels, setBoardLabels] = useState<LabelRow[]>([]);
  const [boardLoading, setBoardLoading] = useState(true);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [activeAgentCount, setActiveAgentCount] = useState(0);

  const [body, setBody] = useState("");
  const [notify, setNotify] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [presetId, setPresetId] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const loadGen = useRef(0);

  const clearTask = useCallback(() => {
    loadGen.current += 1;
    setTask(null);
    setComments([]);
    setAttachments([]);
    setLabels([]);
    setProject(null);
    setThreads([]);
    setPullRequests([]);
    setUnavailableThreadIds([]);
    setError(null);
    setBody("");
  }, []);

  const loadTask = useCallback(
    async (keyOrId: string) => {
      const trimmed = keyOrId.trim();
      if (!trimmed) return;
      const gen = (loadGen.current += 1);
      setLoading(true);
      setError(null);
      try {
        const result = await rpc.call("getView", { keyOrId: trimmed });
        if (gen !== loadGen.current) return;
        if (!result.available || !result.task) {
          setTask(null);
          setComments([]);
          setAttachments([]);
          setLabels([]);
          setProject(null);
          setThreads([]);
          setPullRequests([]);
          setUnavailableThreadIds([]);
          setError(result.error ?? "Task not found.");
          return;
        }
        setTask(result.task);
        setComments(result.comments);
        setAttachments(result.attachments);
        setLabels(result.labels);
        setProject(result.project);
        setThreads(result.threads);
        setPullRequests(result.pullRequests);
        setUnavailableThreadIds(result.unavailableThreadIds);
        setError(null);
        requestAnimationFrame(() => composerRef.current?.focus());
      } catch (err) {
        if (gen !== loadGen.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === loadGen.current) setLoading(false);
      }
    },
    [rpc],
  );

  const openTask = useCallback(
    (keyOrId: string) => {
      const trimmed = keyOrId.trim();
      if (!trimmed) return;
      if (syncSubPath) {
        navigate.toPluginPanel("compose", { subPath: trimmed });
        return;
      }
      void loadTask(trimmed);
    },
    [loadTask, navigate, syncSubPath],
  );

  const closeTask = useCallback(() => {
    if (syncSubPath) {
      navigate.toPluginPanel("compose", { subPath: "", replace: true });
    }
    clearTask();
  }, [clearTask, navigate, syncSubPath]);

  // URL / panel subPath is source of truth so browser back returns to the list.
  useEffect(() => {
    const key = initialKey.trim();
    if (!key) {
      clearTask();
      return;
    }
    void loadTask(key);
  }, [clearTask, initialKey, loadTask]);

  const loadBoard = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setBoardLoading(true);
    try {
      const [result, countResult] = await Promise.all([
        rpc.call("listBoard", null),
        rpc.call("activeCount", null),
      ]);
      if (!result.available) {
        setBoardError(result.error ?? "Tasks unavailable.");
        setBoardProjects([]);
        setBoardFolders([]);
        setBoardTasks([]);
        setBoardLabels([]);
        return;
      }
      setBoardError(null);
      setBoardProjects(result.projects);
      setBoardFolders(result.folders);
      setBoardTasks(result.tasks);
      setBoardLabels(result.labels);
      if (countResult.available) setActiveAgentCount(countResult.count);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!opts?.silent) setBoardLoading(false);
    }
  }, [rpc]);

  const refreshPresets = useCallback(
    async (preferId = "") => {
      try {
        const result = await rpc.call("listPresets", null);
        setPresets(result.presets);
        setPresetId((current) =>
          pickDefaultPresetId(result.presets, preferId || current),
        );
      } catch {
        setPresets([]);
      }
    },
    [rpc],
  );

  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  useEffect(() => {
    setListPref(loadListPreference(listScope));
  }, [listScope]);

  useEffect(() => {
    if (task) return;
    void loadBoard();
    const refresh = () => void loadBoard({ silent: true });
    const interval = window.setInterval(refresh, 8000);
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loadBoard, task]);

  const visibleTasks = useMemo(() => {
    const q = boardQuery.trim().toLowerCase();
    const labelIds = selectedLabelIds(
      labelFilterOptions(boardLabels),
      listPref.filters.labelNames,
    );
    const filtered = boardTasks.filter((item) => {
      if (boardProjectId && item.projectId !== boardProjectId) return false;
      if (activeOnly && (item.workingThreadCount ?? 0) === 0) {
        return false;
      }
      if (!matchesFilters(item, listPref.filters, labelIds)) return false;
      if (!q) return true;
      const haystack =
        `${item.key} ${item.title} ${item.description}`.toLowerCase();
      return haystack.includes(q);
    });
    return sortTasks(filtered, listPref.sort);
  }, [
    activeOnly,
    boardLabels,
    boardProjectId,
    boardQuery,
    boardTasks,
    listPref,
  ]);

  const setListFilters = (filters: ListFilters) => {
    setListPref((current) => {
      const updated = { filters, sort: current.sort };
      storeListPreference(listScope, updated);
      return updated;
    });
  };

  const setListSort = (sort: TaskSort) => {
    setListPref((current) => {
      const updated = { filters: current.filters, sort };
      storeListPreference(listScope, updated);
      return updated;
    });
  };

  const applyPatch = useCallback(
    async (patch: {
      status?: TaskStatus;
      priority?: TaskPriority;
      dueDate?: string | null;
      labelIds?: string[];
    }) => {
      if (!task || saving) return;
      setSaving(true);
      try {
        const result = await rpc.call("updateTask", {
          taskId: task.id,
          ...patch,
        });
        if (!result.ok || !result.task) {
          toast.error(result.error ?? "Update failed.");
          return;
        }
        const updated = result.task;
        setTask(updated);
        setBoardTasks((current) =>
          current.map((item) =>
            item.id === updated.id
              ? {
                  ...item,
                  title: updated.title,
                  status: updated.status,
                  priority: updated.priority,
                  dueDate: updated.dueDate,
                  labelIds: updated.labelIds,
                }
              : item,
          ),
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [rpc, saving, task],
  );

  const toggleLabel = useCallback(
    (labelId: string) => {
      if (!task) return;
      const next = task.labelIds.includes(labelId)
        ? task.labelIds.filter((id) => id !== labelId)
        : [...task.labelIds, labelId];
      void applyPatch({ labelIds: next });
    },
    [applyPatch, task],
  );

  const onPresetChange = (nextId: string) => {
    setPresetId(nextId);
    if (nextId) writeStoredPresetId(nextId);
  };

  const onDispatch = useCallback(async () => {
    if (!task || !presetId || dispatching) return;
    setDispatching(true);
    try {
      const result = await rpc.call("dispatch", {
        taskId: task.id,
        presetId,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Failed to spin agent.");
        return;
      }
      const presetName =
        presets.find((preset) => preset.id === presetId)?.name ?? "Agent";
      toast.success(`${presetName} started on ${task.key}.`);
      await loadTask(task.key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  }, [dispatching, loadTask, presetId, presets, rpc, task]);

  const onSubmit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (!task || submitting) return;
      const trimmed = body.trim();
      if (!trimmed) {
        toast.error("Write a comment first.");
        return;
      }
      setSubmitting(true);
      try {
        const result = await rpc.call("postComment", {
          taskId: task.id,
          body: trimmed,
          notify,
        });
        if (!result.ok || !result.comment) {
          toast.error(result.error ?? "Failed to post comment.");
          return;
        }
        setBody("");
        toast.success(
          notify
            ? `Comment posted on ${task.key} (notify requested).`
            : `Comment posted on ${task.key}.`,
        );
        const view = await rpc.call("getView", { keyOrId: task.key });
        if (view.task) {
          setTask(view.task);
          setComments(view.comments);
          setAttachments(view.attachments);
          setLabels(view.labels);
          setProject(view.project);
          setThreads(view.threads);
          setPullRequests(view.pullRequests);
          setUnavailableThreadIds(view.unavailableThreadIds);
        } else {
          setComments((prev) => [...prev, result.comment!]);
        }
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [body, notify, rpc, submitting, task],
  );

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void onSubmit();
    }
  };

  const recentComments = useMemo(
    () => [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments],
  );

  const projectLabels = useMemo(
    () => labels.filter((label) => !task || label.projectId === task.projectId),
    [labels, task],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 md:px-5">
        {task ? (
          <Button type="button" variant="outline" size="sm" onClick={closeTask}>
            All tasks
          </Button>
        ) : (
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <span>
              {boardLoading
                ? "Loading tasks…"
                : activeOnly
                  ? `Active · ${visibleTasks.length}`
                  : boardProjectId
                    ? `${visibleTasks.length} tasks`
                    : `${visibleTasks.length} of ${boardTasks.length} tasks`}
            </span>
            {!boardLoading ? (
              <>
                {activeAgentCount > 0 ? <WorkingDot /> : null}
                <span className="tabular-nums">{activeAgentCount}</span>
              </>
            ) : null}
          </p>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void (task ? loadTask(task.key) : loadBoard())}
            disabled={task ? loading || dispatching : boardLoading}
          >
            Refresh
          </Button>
          {task ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!sidebarCollapsed}
              onClick={() => {
                const next = !sidebarCollapsed;
                setSidebarCollapsed(next);
                writeSidebarCollapsed(next);
              }}
            >
              <Icon name="PanelRight" className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {task ? (
        <div className="shrink-0 border-b border-border px-4 py-2 md:hidden md:px-5">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
            <label className="sr-only" htmlFor="tcf-preset">
              Agent preset
            </label>
            <select
              id="tcf-preset"
              aria-label="Agent preset"
              className={cn(selectClass, "min-w-0 flex-1")}
              value={presetId}
              onChange={(event) => onPresetChange(event.target.value)}
              disabled={dispatching || presets.length === 0}
            >
              {presets.length === 0 ? (
                <option value="">No presets</option>
              ) : (
                presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))
              )}
            </select>
            <Button
              type="button"
              size="sm"
              onClick={() => void onDispatch()}
              disabled={!presetId || dispatching || loading}
            >
              {dispatching ? "Spinning…" : "Spin agent"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {!task ? (
          <TaskList
            query={boardQuery}
            onQueryChange={setBoardQuery}
            projectId={boardProjectId}
            onProjectChange={(id) =>
              setBrowseScope({ projectId: id, activeOnly: false })
            }
            activeOnly={activeOnly}
            onActiveOnlyChange={(next) =>
              setBrowseScope({
                projectId: next ? "" : boardProjectId,
                activeOnly: next,
              })
            }
            filters={listPref.filters}
            onFiltersChange={setListFilters}
            sort={listPref.sort}
            onSortChange={setListSort}
            projects={boardProjects}
            folders={boardFolders}
            tasks={visibleTasks}
            labels={boardLabels}
            loading={boardLoading}
            error={boardError ?? error}
            onOpen={(key) => void openTask(key)}
          />
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-5 md:px-5">
            <header className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-sm text-foreground">{task.key}</span>
                {project ? (
                  <span className="inline-flex items-center gap-1.5">
                    <ProjectDot color={project.color} />
                    {project.name}
                  </span>
                ) : null}
                {saving ? <span>Saving…</span> : null}
              </div>
              <h1 className="text-xl font-semibold tracking-tight">{task.title}</h1>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:hidden">
                <FieldSelect
                  label="Status"
                  value={task.status}
                  disabled={saving}
                  options={TASK_STATUSES.map((status) => ({
                    value: status,
                    label: STATUS_LABELS[status],
                  }))}
                  onChange={(value) =>
                    void applyPatch({ status: value as TaskStatus })
                  }
                />
                <FieldSelect
                  label="Priority"
                  value={task.priority}
                  disabled={saving}
                  options={TASK_PRIORITIES.map((priority) => ({
                    value: priority,
                    label: PRIORITY_LABELS[priority],
                  }))}
                  onChange={(value) =>
                    void applyPatch({ priority: value as TaskPriority })
                  }
                />
                <label className="flex min-w-0 flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Due
                  <input
                    type="date"
                    className={cn(selectClass, "w-full")}
                    value={task.dueDate ?? ""}
                    disabled={saving}
                    onChange={(event) =>
                      void applyPatch({
                        dueDate: event.target.value ? event.target.value : null,
                      })
                    }
                  />
                </label>
              </div>
              <div className="space-y-1.5 md:hidden">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Labels
                </p>
                {projectLabels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No labels on this project.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {projectLabels.map((label) => (
                      <LabelChip
                        key={label.id}
                        label={label}
                        selected={task.labelIds.includes(label.id)}
                        onToggle={() => toggleLabel(label.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </header>

            {threads.length > 0 ? (
              <section>
                <div className="mb-2 flex items-center gap-2 pt-1.5 text-xs font-semibold text-muted-foreground">
                  Agent threads
                  {threads.filter(
                    (thread) =>
                      thread.liveStatus === "working" ||
                      thread.liveStatus === "starting",
                  ).length > 0 ? (
                    <span className="font-normal">
                      {
                        threads.filter(
                          (thread) =>
                            thread.liveStatus === "working" ||
                            thread.liveStatus === "starting",
                        ).length
                      }{" "}
                      working now
                    </span>
                  ) : null}
                </div>
                {threads.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    pullRequest={pullRequests.find((pr) =>
                      pr.threadIds.includes(thread.threadId),
                    )}
                    pullRequestUnavailable={unavailableThreadIds.includes(
                      thread.threadId,
                    )}
                    onOpen={(threadId) => navigate.toThread(threadId)}
                  />
                ))}
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">No threads attached.</p>
            )}

            <section className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Description
              </h2>
              {task.description.trim() ? (
                <Markdown
                  content={task.description}
                  className="text-sm leading-relaxed text-foreground/90"
                />
              ) : (
                <p className="text-sm text-muted-foreground">No description.</p>
              )}
            </section>

            {attachments.length > 0 ? (
              <section className="space-y-2">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Attachments
                </h2>
                <ul className="space-y-1 text-sm">
                  {attachments.map((file) => (
                    <li
                      key={file.id}
                      className="flex items-center gap-2 text-muted-foreground"
                    >
                      <span className="truncate text-foreground">{file.fileName}</span>
                      <span className="text-xs">
                        {file.isImage ? "image" : file.mime}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="space-y-3 pb-4">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Comments ({recentComments.length})
              </h2>
              {recentComments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
              ) : (
                <ul className="space-y-3">
                  {recentComments.map((comment) => (
                    <li
                      key={comment.id}
                      className="rounded-md border border-border/80 bg-card/40 px-3 py-2"
                    >
                      <div className="mb-1 flex flex-wrap items-baseline gap-1.5 text-xs">
                        <CommentAuthor
                          comment={comment}
                          threads={threads}
                          onOpenThread={(threadId) => navigate.toThread(threadId)}
                        />
                        {comment.kind === "agent" && comment.presetName ? (
                          <span className="rounded-sm bg-secondary px-1 py-px text-[10px] font-semibold text-muted-foreground">
                            {comment.presetName}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground">
                          {formatWhen(comment.createdAt)}
                        </span>
                      </div>
                      {comment.body.trim() ? (
                        <Markdown
                          content={comment.body}
                          className="text-sm leading-relaxed"
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
      {!sidebarCollapsed && task ? (
        <PropertiesRail
          task={task}
          project={project}
          labels={projectLabels}
          threads={threads}
          presets={presets}
          presetId={presetId}
          onPresetChange={onPresetChange}
          onDispatch={() => void onDispatch()}
          dispatching={dispatching}
          saving={saving}
          onUpdate={(patch) => void applyPatch(patch)}
          onToggleLabel={toggleLabel}
          onOpenThread={(threadId) => navigate.toThread(threadId)}
        />
      ) : null}
      </div>

      {task ? (
        <form
          onSubmit={(event) => void onSubmit(event)}
          className={cn(
            "shrink-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-5",
            "shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.35)]",
          )}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <label className="sr-only" htmlFor="tcf-comment">
              Comment
            </label>
            <textarea
              id="tcf-comment"
              ref={composerRef}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={onComposerKeyDown}
              disabled={submitting}
              rows={4}
              placeholder={`Comment on ${task.key}… (⌘/Ctrl+Enter to send)`}
              className={cn(
                "w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                "min-h-[5.5rem] max-h-48",
              )}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(event) => setNotify(event.target.checked)}
                  disabled={submitting}
                  className="size-4 accent-foreground"
                />
                Notify last agent reply
              </label>
              <Button
                type="submit"
                className="ml-auto"
                disabled={submitting || !body.trim()}
              >
                {submitting ? "Posting…" : "Post comment"}
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function NavComposePanel({ subPath }: { subPath: string }) {
  const initialKey = decodeURIComponent(
    subPath.replace(/^\/+/, "").split("/")[0] ?? "",
  );
  return <TaskCommentPanel initialKey={initialKey} syncSubPath />;
}

/**
 * Permanent Tasks Pro right sidebar (All / Active / projects + create).
 * Used as the navPanel Navigation fixed tab and as the thread / New-thread
 * panel action so the same chrome is available everywhere a right panel exists.
 */
function TasksProSidebar(_props: {
  subPath?: string;
  threadId?: string;
  projectId?: string | null;
  params?: JsonValue | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [browseScope, setBrowseScope] = useBrowseScope();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [activeAgentCount, setActiveAgentCount] = useState(0);
  const [presetDialog, setPresetDialog] = useState<{
    key: number;
    editing: PresetRow | null;
  } | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);

  const openBrowseScreen = useCallback(
    (scope: BrowseScope) => {
      setBrowseScope(scope);
      // Leave task detail (or another surface) and land on the filtered list.
      navigate.toPluginPanel("compose", { subPath: "" });
    },
    [navigate, setBrowseScope],
  );

  const refresh = useCallback(async () => {
    try {
      const [board, countResult, presetResult] = await Promise.all([
        rpc.call("listBoard", null),
        rpc.call("activeCount", null),
        rpc.call("listPresets", null),
      ]);
      if (board.available) {
        setProjects(board.projects);
        setFolders(board.folders);
        setTasks(board.tasks);
      }
      if (countResult.available) setActiveAgentCount(countResult.count);
      setPresets(presetResult.presets);
    } catch {
      // Keep last successful snapshot.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 8000);
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  return (
    <>
      <ListSidebar
        projects={projects}
        folders={folders}
        tasks={tasks}
        presets={presets}
        activeAgentCount={activeAgentCount}
        projectId={browseScope.projectId}
        activeOnly={browseScope.activeOnly}
        onSelectAll={() =>
          openBrowseScreen({ projectId: "", activeOnly: false })
        }
        onSelectActive={() =>
          openBrowseScreen({ projectId: "", activeOnly: true })
        }
        onSelectProject={(id) =>
          openBrowseScreen({ projectId: id, activeOnly: false })
        }
        onEditPreset={(preset) =>
          setPresetDialog({ key: Date.now(), editing: preset })
        }
        onNewPreset={() => setPresetDialog({ key: Date.now(), editing: null })}
        onNewProject={() => setProjectDialogOpen(true)}
        onNewTask={() => setTaskDialogOpen(true)}
      />
      <TaskDialog
        open={taskDialogOpen}
        projects={projects}
        defaultProjectId={browseScope.projectId}
        onOpenChange={setTaskDialogOpen}
        onCreated={(created) => {
          void refresh();
          navigate.toPluginPanel("compose", { subPath: created.key });
        }}
      />
      <ProjectDialog
        open={projectDialogOpen}
        projects={projects}
        folders={folders}
        onOpenChange={setProjectDialogOpen}
        onCreated={(project) => {
          openBrowseScreen({ projectId: project.id, activeOnly: false });
          void refresh();
        }}
      />
      {presetDialog ? (
        <PresetDialog
          key={presetDialog.key}
          open
          editing={presetDialog.editing}
          onOpenChange={(open) => {
            if (!open) setPresetDialog(null);
          }}
          onSaved={(preset) => {
            writeStoredPresetId(preset.id);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Same meaning as Tasks' Active row: tasks with a starting/working agent. */
function ActiveTaskCountAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [count, setCount] = useState<number | null>(null);
  const seenConnected = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("activeCount", null);
      if (result.available) setCount(result.count);
    } catch {
      // Keep the last successful count.
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 6000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useRealtime("active-count", () => {
    void refresh();
  });

  useEffect(() => {
    if (connection !== "connected") return;
    if (seenConnected.current) void refresh();
    seenConnected.current = true;
  }, [connection, refresh]);

  if (count == null) return null;
  return (
    <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
  );
}

const THREAD_SIDEBAR_ACTION_ID = "compose";
const THREAD_AUTO_OPEN_KEY_PREFIX = "task-comment-float:auto-open:";

function threadAutoOpenKey(threadId: string): string {
  return `${THREAD_AUTO_OPEN_KEY_PREFIX}${threadId}`;
}

function hasAutoOpenedThreadSidebar(threadId: string): boolean {
  try {
    return window.sessionStorage.getItem(threadAutoOpenKey(threadId)) === "1";
  } catch {
    return false;
  }
}

function markAutoOpenedThreadSidebar(threadId: string): void {
  try {
    window.sessionStorage.setItem(threadAutoOpenKey(threadId), "1");
  } catch {
    // Ignore quota / private-mode failures.
  }
}

/** Open (or focus) the Tasks Pro tab in the current thread's right panel. */
function openTasksProThreadSidebar(navigate: ReturnType<typeof useBbNavigate>): boolean {
  return navigate.openThreadPanel({
    actionId: THREAD_SIDEBAR_ACTION_ID,
    title: "Tasks Pro",
  });
}

/**
 * Thread header control + once-per-thread auto-open for the Tasks Pro tab.
 *
 * On threads, the host right panel is a shared tab strip (Terminal, Browser,
 * files, plugin actions). `openThreadPanel` always activates the tab.
 *
 * Behavior:
 * - First time a thread is shown this session → create/open Tasks Pro.
 * - After that we do not call open again for that thread, so switching to
 *   Terminal/Browser keeps focus, and closing the Tasks Pro tab (or the
 *   whole panel) is respected until you reopen via this control / Actions.
 * - Host panel state is per-thread, so an unclosed tab usually returns with
 *   the thread; a closed tab stays closed until you ask for it again.
 */
function ThreadTasksProSidebarGate({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();

  useEffect(() => {
    if (hasAutoOpenedThreadSidebar(threadId)) return;

    let cancelled = false;
    let attempts = 0;
    let timer = 0;

    const tryOpen = () => {
      if (cancelled) return;
      attempts += 1;
      if (openTasksProThreadSidebar(navigate)) {
        markAutoOpenedThreadSidebar(threadId);
        return;
      }
      // Panel surface may not be ready on the first frame.
      if (attempts < 8) {
        timer = window.setTimeout(tryOpen, 50 * attempts);
      }
    };

    const raf = window.requestAnimationFrame(tryOpen);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [navigate, threadId]);

  return (
    <button
      type="button"
      title="Tasks Pro — right panel tab (alongside Terminal, Browser, files)"
      aria-label="Open Tasks Pro in the right panel"
      className={cn(
        "inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        isCompactViewport ? "size-8" : "h-8 gap-1.5 px-2 text-xs font-medium",
      )}
      onClick={() => {
        if (openTasksProThreadSidebar(navigate)) {
          markAutoOpenedThreadSidebar(threadId);
        }
      }}
    >
      <Icon name="ListView" className="size-3.5 shrink-0" />
      {isCompactViewport ? null : <span>Tasks Pro</span>}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "compose",
    title: "Tasks Pro",
    icon: "MessageAdd01",
    path: "compose",
    component: NavComposePanel,
    experimental_sidebarAccessory: ActiveTaskCountAccessory,
    // Runtime (bb ≥0.38) supports fixed tabs; SDK 0.4.6 typings omit the field.
    // Fixed Navigation coexists with host Browser / Terminal tabs on this page.
    ...({
      experimental_fixedTabs: [
        {
          id: "navigation",
          title: "Navigation",
          icon: "ListView",
          component: TasksProSidebar,
          layout: "flush",
        },
      ],
    } as Record<string, unknown>),
  });

  // Peer tab in the thread right-panel strip (with Terminal / Browser / files).
  app.slots.threadPanelAction({
    id: THREAD_SIDEBAR_ACTION_ID,
    title: "Tasks Pro",
    icon: "MessageAdd01",
    layout: "flush",
    component: TasksProSidebar,
    run: ({ openPanel }) => {
      openPanel({ title: "Tasks Pro" });
    },
  });

  // Same peer tab on the root New thread screen.
  app.slots.experimental_newThreadPanelAction({
    id: THREAD_SIDEBAR_ACTION_ID,
    title: "Tasks Pro",
    icon: "MessageAdd01",
    layout: "flush",
    component: TasksProSidebar,
    run: ({ openPanel }) => {
      openPanel({ title: "Tasks Pro" });
    },
  });

  // Explicit open only — never auto-steal focus from Terminal/Browser/files.
  // title is required by the host validator; omitting it fails the whole app setup.
  app.slots.experimental_threadHeaderAction({
    id: "tasks-pro-sidebar",
    title: "Tasks Pro",
    component: ThreadTasksProSidebarGate,
  });
});
