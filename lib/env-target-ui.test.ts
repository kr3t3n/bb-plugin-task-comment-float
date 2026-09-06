// Contract check for the Spin agent environment picker (TPRO-4).
//
// The picker builds the `envTarget` field that the server validates with
// `envTargetSchema` from lib/env-target.ts. That schema is strict, so an extra
// or misspelled key is a dispatch failure at runtime rather than a type error.
// These tests run the exact payloads the UI emits through the real schema.
import { describe, expect, it } from "vitest";
import { envTargetSchema } from "./env-target";
import {
  EMPTY_ENV_TARGET,
  ENV_TARGET_KINDS,
  ENV_TARGET_LABELS,
  environmentOptionLabel,
  envTargetError,
  envTargetInput,
  isEnvTargetKind,
  type EnvTargetDraft,
} from "./env-target-ui";

function draft(patch: Partial<EnvTargetDraft> = {}): EnvTargetDraft {
  return { ...EMPTY_ENV_TARGET, ...patch };
}

describe("envTargetInput", () => {
  it("omits the field for the preset default so dispatch stays on Tasks delegate", () => {
    expect(envTargetInput(draft())).toBeUndefined();
  });

  it("emits a profile target the server schema accepts", () => {
    const input = envTargetInput(draft({ kind: "profile", profileId: "p1" }));
    expect(input).toEqual({ kind: "profile", profileId: "p1" });
    expect(envTargetSchema.safeParse(input).success).toBe(true);
  });

  it("emits a reuse target the server schema accepts", () => {
    const input = envTargetInput(
      draft({ kind: "reuse", environmentId: " env_26d29dci94 " }),
    );
    expect(input).toEqual({ kind: "reuse", environmentId: "env_26d29dci94" });
    expect(envTargetSchema.safeParse(input).success).toBe(true);
  });

  it("emits a path target without a branch when none is typed", () => {
    const input = envTargetInput(
      draft({ kind: "path", path: " /home/bb/projects/sre-uat " }),
    );
    expect(input).toEqual({ kind: "path", path: "/home/bb/projects/sre-uat" });
    expect(envTargetSchema.safeParse(input).success).toBe(true);
  });

  it("emits a path target with a branch when one is typed", () => {
    const input = envTargetInput(
      draft({ kind: "path", path: "/srv/app", branch: " main " }),
    );
    expect(input).toEqual({ kind: "path", path: "/srv/app", branch: "main" });
    expect(envTargetSchema.safeParse(input).success).toBe(true);
  });

  it("never carries fields the chosen kind does not need", () => {
    // A draft the operator filled in, then switched back to another kind.
    const busy = draft({
      kind: "reuse",
      profileId: "p1",
      environmentId: "env_1",
      path: "/tmp/x",
      branch: "main",
    });
    expect(envTargetInput(busy)).toEqual({
      kind: "reuse",
      environmentId: "env_1",
    });
    expect(envTargetSchema.safeParse(envTargetInput(busy)).success).toBe(true);
  });
});

describe("envTargetError", () => {
  it("accepts the preset default with nothing else filled in", () => {
    expect(envTargetError(draft())).toBeNull();
  });

  it("blocks dispatch until a profile is chosen", () => {
    expect(envTargetError(draft({ kind: "profile" }))).toBe(
      "Pick an environment profile.",
    );
    expect(envTargetError(draft({ kind: "profile", profileId: "p1" }))).toBeNull();
  });

  it("blocks dispatch until an environment is chosen", () => {
    expect(envTargetError(draft({ kind: "reuse" }))).toBe("Pick an environment.");
    expect(
      envTargetError(draft({ kind: "reuse", environmentId: "env_1" })),
    ).toBeNull();
  });

  it("requires an absolute path", () => {
    expect(envTargetError(draft({ kind: "path" }))).toBe(
      "Enter an absolute path.",
    );
    expect(envTargetError(draft({ kind: "path", path: "relative/dir" }))).toBe(
      "Path must be absolute (start with /).",
    );
    expect(envTargetError(draft({ kind: "path", path: "/srv/app" }))).toBeNull();
  });
});

describe("picker presentation", () => {
  it("labels every kind the server understands", () => {
    for (const kind of ENV_TARGET_KINDS) {
      expect(ENV_TARGET_LABELS[kind]).toBeTruthy();
      expect(isEnvTargetKind(kind)).toBe(true);
    }
    expect(isEnvTargetKind("nonsense")).toBe(false);
  });

  it("separates environments that share a name", () => {
    const base = {
      name: "claude-env",
      projectId: "proj_1",
      hostId: "host_a",
      status: "ready",
      workspaceProvisionType: "managed-worktree",
      isWorktree: true,
    };
    const first = environmentOptionLabel({
      ...base,
      id: "env_a",
      path: "/w/a",
      branchName: "bb/one",
    });
    const second = environmentOptionLabel({
      ...base,
      id: "env_b",
      path: "/w/b",
      branchName: "bb/two",
    });
    expect(first).not.toBe(second);
    expect(first).toContain("bb/one");
  });

  it("flags an environment that is not ready", () => {
    expect(
      environmentOptionLabel({
        id: "env_c",
        name: "sre-uat",
        path: "/home/bb/projects/sre-uat",
        projectId: "proj_1",
        hostId: "host_a",
        branchName: null,
        status: "provisioning",
        workspaceProvisionType: "unmanaged",
        isWorktree: false,
      }),
    ).toContain("(provisioning)");
  });
});
