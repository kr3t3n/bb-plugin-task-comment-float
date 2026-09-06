// Spin agent environment picker model (TPRO-4).
//
// This is the UI half of the environment target feature. `lib/env-target.ts`
// owns the server behaviour; this module owns the draft the operator edits and
// the conversion to the wire shape that module validates.
//
// The types come from `lib/env-target.ts` as type-only imports, so the compiler
// keeps the two halves in step while the frontend bundle stays free of the
// server module's runtime code.
import type {
  EnvProfile,
  EnvTarget,
  EnvTargetKind,
  EnvironmentOption,
} from "./env-target";

/** Order the picker lists the kinds in, widest default first. */
export const ENV_TARGET_KINDS: readonly EnvTargetKind[] = [
  "preset",
  "profile",
  "reuse",
  "path",
];

/** Compilation fails here if the server adds a kind the picker cannot show. */
export const ENV_TARGET_LABELS: Record<EnvTargetKind, string> = {
  preset: "Preset default",
  profile: "Environment profile",
  reuse: "Existing environment",
  path: "Absolute path",
};

/**
 * What the operator picked in the UI. Every branch keeps its own field so
 * switching kinds back and forth does not lose typing; only the fields the
 * chosen kind needs are sent to the server.
 */
export interface EnvTargetDraft {
  kind: EnvTargetKind;
  profileId: string;
  environmentId: string;
  path: string;
  branch: string;
}

export const EMPTY_ENV_TARGET: EnvTargetDraft = {
  kind: "preset",
  profileId: "",
  environmentId: "",
  path: "",
  branch: "",
};

export function isEnvTargetKind(value: string): value is EnvTargetKind {
  return (ENV_TARGET_KINDS as readonly string[]).includes(value);
}

/** Reason the draft cannot be dispatched yet, or null when it is ready. */
export function envTargetError(draft: EnvTargetDraft): string | null {
  if (draft.kind === "profile" && !draft.profileId) {
    return "Pick an environment profile.";
  }
  if (draft.kind === "reuse" && !draft.environmentId.trim()) {
    return "Pick an environment.";
  }
  if (draft.kind === "path") {
    const path = draft.path.trim();
    if (!path) return "Enter an absolute path.";
    if (!path.startsWith("/")) return "Path must be absolute (start with /).";
  }
  return null;
}

/**
 * Convert the draft to the `dispatch` RPC field. Returns undefined for the
 * preset default so the caller omits `envTarget` and the server keeps the
 * untouched Tasks `delegate` path.
 *
 * `envTargetSchema` is strict, so this must emit only the keys the kind needs.
 */
export function envTargetInput(draft: EnvTargetDraft): EnvTarget | undefined {
  switch (draft.kind) {
    case "profile":
      return { kind: "profile", profileId: draft.profileId };
    case "reuse":
      return { kind: "reuse", environmentId: draft.environmentId.trim() };
    case "path": {
      const branch = draft.branch.trim();
      return {
        kind: "path",
        path: draft.path.trim(),
        ...(branch ? { branch } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Environment names repeat heavily (every worktree of a project shares one), so
 * the picker needs the branch or path to tell them apart.
 */
export function environmentOptionLabel(environment: EnvironmentOption): string {
  const detail = environment.branchName ?? environment.path ?? environment.id;
  const base =
    detail && detail !== environment.name
      ? `${environment.name} · ${detail}`
      : environment.name;
  return environment.status === "ready"
    ? base
    : `${base} (${environment.status})`;
}

/** Short one-line summary of where the agent will land. */
export function describeEnvTargetDraft(
  draft: EnvTargetDraft,
  profiles: EnvProfile[],
  environments: EnvironmentOption[],
): string {
  switch (draft.kind) {
    case "profile": {
      const profile = profiles.find((item) => item.id === draft.profileId);
      if (!profile) return "Pick an environment profile";
      return profile.kind === "path"
        ? `${profile.name} · ${profile.path ?? "path"}`
        : `${profile.name} · ${profile.environmentId ?? "environment"}`;
    }
    case "reuse": {
      const environment = environments.find(
        (item) => item.id === draft.environmentId,
      );
      if (!environment) return draft.environmentId || "Pick an environment";
      return environment.path
        ? `${environment.name} · ${environment.path}`
        : environment.name;
    }
    case "path": {
      const path = draft.path.trim() || "absolute path";
      const branch = draft.branch.trim();
      return branch ? `${path} · ${branch}` : path;
    }
    default:
      return "Preset default";
  }
}
