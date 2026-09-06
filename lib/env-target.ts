// Environment targets for Tasks Pro dispatch (TPRO-3).
//
// Tasks' own `delegate` RPC only understands the two preset environment kinds
// (`project-default` and `new-worktree`). Shared checkouts such as
// /home/bb/projects/sre-uat cannot be reached that way, so the agent lands in
// the wrong directory and has to stop mid-turn.
//
// This module models the extra targets, validates them, stores named profiles,
// and converts a target into the `environment` argument that
// `bb.sdk.threads.spawn` expects. It never mutates Tasks state.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const PROFILE_KEY_PREFIX = "env-profile:";
const ENVIRONMENT_SCAN_THREAD_LIMIT = 100;
const ENVIRONMENT_LOOKUP_CONCURRENCY = 8;

export const ENV_TARGET_KINDS = [
  "preset",
  "profile",
  "reuse",
  "path",
] as const;

export type EnvTargetKind = (typeof ENV_TARGET_KINDS)[number];

/**
 * Wire shape shared with the Spin agent UI (TPRO-4). Every field except
 * `kind` is optional so the object stays additive; the server decides which
 * fields a given kind requires.
 */
export const envTargetSchema = z
  .object({
    kind: z.enum(ENV_TARGET_KINDS),
    profileId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    // Only meaningful for kind "path". Defaults to the host that owns the
    // linked bb project's default source.
    hostId: z.string().min(1).optional(),
  })
  .strict();

export type EnvTarget = z.infer<typeof envTargetSchema>;

/** A target after profile lookup: either "leave it to Tasks" or a spawn shape. */
export type ResolvedEnvTarget =
  | { kind: "preset" }
  | { kind: "reuse"; environmentId: string }
  | {
      kind: "path";
      path: string;
      branch: string | null;
      hostId: string | null;
    };

export const envProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["reuse", "path"]),
    environmentId: z.string().nullable().default(null),
    path: z.string().nullable().default(null),
    branch: z.string().nullable().default(null),
    hostId: z.string().nullable().default(null),
    bbProjectId: z.string().nullable().default(null),
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
  })
  .strict();

export type EnvProfile = z.infer<typeof envProfileSchema>;

export type EnvProfileWriteInput = {
  id?: string;
  name: string;
  kind: "reuse" | "path";
  environmentId?: string | null;
  path?: string | null;
  branch?: string | null;
  hostId?: string | null;
  bbProjectId?: string | null;
};

export type EnvironmentOption = {
  id: string;
  name: string;
  path: string | null;
  projectId: string;
  hostId: string;
  branchName: string | null;
  status: string;
  workspaceProvisionType: string;
  isWorktree: boolean;
};

/** Thrown for user-facing input problems so callers can report them verbatim. */
export class EnvTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvTargetError";
  }
}

function profileKey(id: string): string {
  return `${PROFILE_KEY_PREFIX}${id}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newProfileId(): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `envp_${random}`;
}

/** Absolute POSIX path, no trailing slash (except root), no `..` segments. */
export function normalizeHostPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EnvTargetError("Environment path is empty.");
  }
  if (!trimmed.startsWith("/")) {
    throw new EnvTargetError(
      `Environment path must be absolute: ${trimmed}`,
    );
  }
  const segments = trimmed.split("/").filter((part) => part && part !== ".");
  if (segments.includes("..")) {
    throw new EnvTargetError(
      `Environment path must not contain "..": ${trimmed}`,
    );
  }
  return `/${segments.join("/")}`;
}

export function isAbsoluteHostPath(raw: string): boolean {
  try {
    normalizeHostPath(raw);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Profile store (plugin KV; one row per profile)
// ---------------------------------------------------------------------------

export async function listEnvProfiles(bb: BbPluginApi): Promise<EnvProfile[]> {
  const keys = await bb.storage.kv.list(PROFILE_KEY_PREFIX);
  const profiles: EnvProfile[] = [];
  for (const key of keys) {
    if (!key.startsWith(PROFILE_KEY_PREFIX)) continue;
    const stored = await bb.storage.kv.get<unknown>(key);
    const parsed = envProfileSchema.safeParse(stored);
    if (parsed.success) profiles.push(parsed.data);
  }
  profiles.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return profiles;
}

export async function getEnvProfile(
  bb: BbPluginApi,
  id: string,
): Promise<EnvProfile | null> {
  const stored = await bb.storage.kv.get<unknown>(profileKey(id.trim()));
  const parsed = envProfileSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** Resolve by id first, then by case-insensitive name. */
export async function findEnvProfile(
  bb: BbPluginApi,
  idOrName: string,
): Promise<EnvProfile | null> {
  const needle = idOrName.trim();
  if (!needle) return null;
  const byId = await getEnvProfile(bb, needle);
  if (byId) return byId;
  const profiles = await listEnvProfiles(bb);
  return (
    profiles.find(
      (profile) => profile.name.toLowerCase() === needle.toLowerCase(),
    ) ?? null
  );
}

export async function saveEnvProfile(
  bb: BbPluginApi,
  input: EnvProfileWriteInput,
): Promise<EnvProfile> {
  const name = input.name.trim();
  if (!name) throw new EnvTargetError("Profile name is required.");

  const existing = input.id ? await getEnvProfile(bb, input.id) : null;
  if (input.id && !existing) {
    throw new EnvTargetError(`No env profile with id ${input.id}.`);
  }

  const clash = (await listEnvProfiles(bb)).find(
    (profile) =>
      profile.name.toLowerCase() === name.toLowerCase() &&
      profile.id !== existing?.id,
  );
  if (clash) {
    throw new EnvTargetError(`An env profile named “${name}” already exists.`);
  }

  let environmentId: string | null = null;
  let path: string | null = null;
  let branch: string | null = null;
  let hostId: string | null = null;

  if (input.kind === "reuse") {
    const value = input.environmentId?.trim() ?? "";
    if (!value) {
      throw new EnvTargetError("A reuse profile needs an environmentId.");
    }
    environmentId = value;
  } else {
    const value = input.path?.trim() ?? "";
    if (!value) {
      throw new EnvTargetError("A path profile needs an absolute path.");
    }
    path = normalizeHostPath(value);
    branch = input.branch?.trim() || null;
    hostId = input.hostId?.trim() || null;
  }

  const profile: EnvProfile = {
    id: existing?.id ?? newProfileId(),
    name,
    kind: input.kind,
    environmentId,
    path,
    branch,
    hostId,
    bbProjectId: input.bbProjectId?.trim() || null,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  await bb.storage.kv.set(profileKey(profile.id), profile);
  return profile;
}

export async function deleteEnvProfile(
  bb: BbPluginApi,
  idOrName: string,
): Promise<boolean> {
  const profile = await findEnvProfile(bb, idOrName);
  if (!profile) return false;
  await bb.storage.kv.delete(profileKey(profile.id));
  return true;
}

// ---------------------------------------------------------------------------
// Target resolution and validation
// ---------------------------------------------------------------------------

/** Turn a wire target into a resolved one. Does not touch the host yet. */
export async function resolveEnvTarget(
  bb: BbPluginApi,
  target: EnvTarget | null | undefined,
): Promise<ResolvedEnvTarget> {
  if (!target || target.kind === "preset") return { kind: "preset" };

  if (target.kind === "reuse") {
    const environmentId = target.environmentId?.trim() ?? "";
    if (!environmentId) {
      throw new EnvTargetError('envTarget kind "reuse" needs environmentId.');
    }
    return { kind: "reuse", environmentId };
  }

  if (target.kind === "path") {
    const path = target.path?.trim() ?? "";
    if (!path) {
      throw new EnvTargetError('envTarget kind "path" needs an absolute path.');
    }
    return {
      kind: "path",
      path: normalizeHostPath(path),
      branch: target.branch?.trim() || null,
      hostId: target.hostId?.trim() || null,
    };
  }

  const profileId = target.profileId?.trim() ?? "";
  if (!profileId) {
    throw new EnvTargetError('envTarget kind "profile" needs profileId.');
  }
  const profile = await findEnvProfile(bb, profileId);
  if (!profile) {
    throw new EnvTargetError(`No env profile named “${profileId}”.`);
  }
  if (profile.kind === "reuse") {
    if (!profile.environmentId) {
      throw new EnvTargetError(
        `Env profile “${profile.name}” has no environmentId.`,
      );
    }
    return { kind: "reuse", environmentId: profile.environmentId };
  }
  if (!profile.path) {
    throw new EnvTargetError(`Env profile “${profile.name}” has no path.`);
  }
  return {
    kind: "path",
    path: normalizeHostPath(profile.path),
    branch: profile.branch,
    hostId: profile.hostId,
  };
}

/**
 * The host that owns a bb project's default source. That is where a relative
 * "just use this checkout" request should land when the caller names no host.
 */
export async function resolveDefaultHostId(
  bb: BbPluginApi,
  bbProjectId: string,
): Promise<string | null> {
  try {
    const project = await bb.sdk.projects.get({ projectId: bbProjectId });
    const sources = project.sources ?? [];
    const preferred = sources.find((source) => source.isDefault) ?? sources[0];
    return preferred?.hostId ?? null;
  } catch {
    return null;
  }
}

/** Fill in the project's host when a path target did not name one. */
export async function applyDefaultHost(
  bb: BbPluginApi,
  resolved: ResolvedEnvTarget,
  bbProjectId: string,
): Promise<ResolvedEnvTarget> {
  if (resolved.kind !== "path" || resolved.hostId) return resolved;
  const hostId = await resolveDefaultHostId(bb, bbProjectId);
  if (!hostId) {
    throw new EnvTargetError(
      `Could not determine a host for ${resolved.path}. ` +
        "Pass an explicit host id, or give the bb project a default source.",
    );
  }
  return { ...resolved, hostId };
}

/**
 * Check the target against the host before we spawn. A bad path or a retired
 * environment should fail here with a readable message, not halfway through
 * thread creation.
 */
export async function validateEnvTarget(
  bb: BbPluginApi,
  resolved: ResolvedEnvTarget,
): Promise<void> {
  if (resolved.kind === "preset") return;

  if (resolved.kind === "reuse") {
    let environment: { status: string; path: string | null };
    try {
      environment = await bb.sdk.environments.get({
        environmentId: resolved.environmentId,
      });
    } catch (error) {
      throw new EnvTargetError(
        `Environment ${resolved.environmentId} is not readable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      environment.status === "destroyed" ||
      environment.status === "destroying" ||
      environment.status === "retiring"
    ) {
      throw new EnvTargetError(
        `Environment ${resolved.environmentId} is ${environment.status}.`,
      );
    }
    return;
  }

  try {
    // `files.list` succeeds only for a readable directory on the host.
    await bb.sdk.files.list({
      path: resolved.path,
      limit: 1,
      ...(resolved.hostId ? { hostId: resolved.hostId } : {}),
    });
  } catch (error) {
    throw new EnvTargetError(
      `Environment path ${resolved.path} is not a readable directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The `environment` argument for `bb.sdk.threads.spawn`. */
export function toSpawnEnvironment(
  resolved: Exclude<ResolvedEnvTarget, { kind: "preset" }>,
):
  | { type: "reuse"; environmentId: string }
  | {
      type: "host";
      hostId?: string;
      workspace: {
        type: "unmanaged";
        path: string;
        branch?: { kind: "existing"; name: string };
      };
    } {
  if (resolved.kind === "reuse") {
    return { type: "reuse", environmentId: resolved.environmentId };
  }
  return {
    type: "host",
    ...(resolved.hostId ? { hostId: resolved.hostId } : {}),
    workspace: {
      type: "unmanaged",
      path: resolved.path,
      ...(resolved.branch
        ? { branch: { kind: "existing" as const, name: resolved.branch } }
        : {}),
    },
  };
}

/** One-line summary for comments and CLI output. */
export function describeEnvTarget(resolved: ResolvedEnvTarget): string {
  if (resolved.kind === "preset") return "preset default";
  if (resolved.kind === "reuse") {
    return `existing environment ${resolved.environmentId}`;
  }
  return resolved.branch
    ? `${resolved.path} (branch ${resolved.branch})`
    : resolved.path;
}

// ---------------------------------------------------------------------------
// Environment discovery
// ---------------------------------------------------------------------------

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

function environmentLabel(environment: {
  id: string;
  name: string | null;
  path: string | null;
}): string {
  const named = environment.name?.trim();
  if (named) return named;
  const path = environment.path?.trim();
  if (path) {
    const base = path.split("/").filter(Boolean).pop();
    if (base) return base;
  }
  return environment.id;
}

/**
 * The SDK exposes `environments.get` but no `environments.list`, so we collect
 * the environment ids referenced by recent threads and read each one. That
 * covers every environment a user has actually worked in. The manual absolute
 * path stays the escape hatch for anything else.
 */
export async function listEnvironmentOptions(
  bb: BbPluginApi,
  input: { bbProjectId?: string | null } = {},
): Promise<EnvironmentOption[]> {
  const bbProjectId = input.bbProjectId?.trim() || undefined;
  const threads = await bb.sdk.threads.list({
    ...(bbProjectId ? { projectId: bbProjectId } : {}),
    archived: false,
    includeHidden: true,
    limit: ENVIRONMENT_SCAN_THREAD_LIMIT,
  });

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    const id = thread.environmentId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const rows = await mapWithConcurrency(
    ids,
    ENVIRONMENT_LOOKUP_CONCURRENCY,
    async (id): Promise<EnvironmentOption | null> => {
      try {
        const environment = await bb.sdk.environments.get({
          environmentId: id,
        });
        if (bbProjectId && environment.projectId !== bbProjectId) return null;
        return {
          id: environment.id,
          name: environmentLabel(environment),
          path: environment.path,
          projectId: environment.projectId,
          hostId: environment.hostId,
          branchName: environment.branchName,
          status: environment.status,
          workspaceProvisionType: environment.workspaceProvisionType,
          isWorktree: environment.isWorktree,
        };
      } catch {
        return null;
      }
    },
  );

  return rows
    .filter((row): row is EnvironmentOption => row != null)
    .filter((row) => row.status !== "destroyed")
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}
