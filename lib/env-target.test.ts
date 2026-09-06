import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  applyDefaultHost,
  deleteEnvProfile,
  describeEnvTarget,
  EnvTargetError,
  findEnvProfile,
  isAbsoluteHostPath,
  listEnvProfiles,
  listEnvironmentOptions,
  normalizeHostPath,
  resolveDefaultHostId,
  resolveEnvTarget,
  saveEnvProfile,
  toSpawnEnvironment,
  validateEnvTarget,
} from "./env-target";

type FakeEnvironment = {
  id: string;
  name: string | null;
  projectId: string;
  hostId: string;
  path: string | null;
  branchName: string | null;
  status: string;
  workspaceProvisionType: string;
  isWorktree: boolean;
};

type FakeThread = { id: string; projectId: string; environmentId: string | null };

function fakeBb(options: {
  environments?: FakeEnvironment[];
  threads?: FakeThread[];
  readableDirs?: string[];
  projectSources?: Record<
    string,
    { id: string; hostId: string; path: string; isDefault: boolean }[]
  >;
} = {}) {
  const store = new Map<string, unknown>();
  const environments = new Map(
    (options.environments ?? []).map((row) => [row.id, row]),
  );
  const readableDirs = new Set(options.readableDirs ?? []);
  const listCalls: { projectId?: string }[] = [];
  const fileListCalls: { path: string; hostId?: string }[] = [];

  const bb = {
    storage: {
      kv: {
        async get<T>(key: string): Promise<T | undefined> {
          return store.get(key) as T | undefined;
        },
        async set(key: string, value: unknown): Promise<void> {
          store.set(key, JSON.parse(JSON.stringify(value)));
        },
        async delete(key: string): Promise<void> {
          store.delete(key);
        },
        async list(prefix?: string): Promise<string[]> {
          return [...store.keys()].filter(
            (key) => !prefix || key.startsWith(prefix),
          );
        },
      },
    },
    sdk: {
      environments: {
        async get({ environmentId }: { environmentId: string }) {
          const found = environments.get(environmentId);
          if (!found) throw new Error(`no environment ${environmentId}`);
          return found;
        },
      },
      files: {
        async list(args: { path: string; hostId?: string }) {
          fileListCalls.push(args);
          if (!readableDirs.has(args.path)) {
            throw new Error("ENOTDIR");
          }
          return { entries: [] };
        },
      },
      projects: {
        async get({ projectId }: { projectId: string }) {
          const sources = options.projectSources?.[projectId];
          if (!sources) throw new Error(`no project ${projectId}`);
          return { id: projectId, sources };
        },
      },
      threads: {
        async list(args: { projectId?: string }) {
          listCalls.push(args);
          const rows = options.threads ?? [];
          return args.projectId
            ? rows.filter((row) => row.projectId === args.projectId)
            : rows;
        },
      },
    },
  };

  return {
    bb: bb as unknown as BbPluginApi,
    store,
    listCalls,
    fileListCalls,
  };
}

describe("normalizeHostPath", () => {
  it("keeps a plain absolute path", () => {
    expect(normalizeHostPath("/home/bb/projects/sre-uat")).toBe(
      "/home/bb/projects/sre-uat",
    );
  });

  it("trims whitespace, trailing slashes, dots, and doubled separators", () => {
    expect(normalizeHostPath("  /home//bb/./projects/sre-uat/  ")).toBe(
      "/home/bb/projects/sre-uat",
    );
  });

  it("rejects a relative path", () => {
    expect(() => normalizeHostPath("projects/sre-uat")).toThrow(EnvTargetError);
  });

  it("rejects a path with a parent segment", () => {
    expect(() => normalizeHostPath("/home/bb/../root")).toThrow(EnvTargetError);
  });

  it("rejects an empty path", () => {
    expect(() => normalizeHostPath("   ")).toThrow(EnvTargetError);
  });

  it("reports absoluteness without throwing", () => {
    expect(isAbsoluteHostPath("/tmp")).toBe(true);
    expect(isAbsoluteHostPath("tmp")).toBe(false);
  });
});

describe("resolveEnvTarget", () => {
  it("treats a missing target as the preset default", async () => {
    const { bb } = fakeBb();
    await expect(resolveEnvTarget(bb, undefined)).resolves.toEqual({
      kind: "preset",
    });
    await expect(resolveEnvTarget(bb, null)).resolves.toEqual({
      kind: "preset",
    });
    await expect(resolveEnvTarget(bb, { kind: "preset" })).resolves.toEqual({
      kind: "preset",
    });
  });

  it("resolves a reuse target", async () => {
    const { bb } = fakeBb();
    await expect(
      resolveEnvTarget(bb, { kind: "reuse", environmentId: "env_1" }),
    ).resolves.toEqual({ kind: "reuse", environmentId: "env_1" });
  });

  it("rejects a reuse target with no environmentId", async () => {
    const { bb } = fakeBb();
    await expect(resolveEnvTarget(bb, { kind: "reuse" })).rejects.toThrow(
      EnvTargetError,
    );
  });

  it("resolves and normalizes a path target with a branch", async () => {
    const { bb } = fakeBb();
    await expect(
      resolveEnvTarget(bb, {
        kind: "path",
        path: "/home/bb/projects/sre-uat/",
        branch: "uat",
      }),
    ).resolves.toEqual({
      kind: "path",
      path: "/home/bb/projects/sre-uat",
      branch: "uat",
      hostId: null,
    });
  });

  it("carries an explicit hostId on a path target", async () => {
    const { bb } = fakeBb();
    await expect(
      resolveEnvTarget(bb, {
        kind: "path",
        path: "/srv/app",
        hostId: "host_mxyy2ss6zf",
      }),
    ).resolves.toEqual({
      kind: "path",
      path: "/srv/app",
      branch: null,
      hostId: "host_mxyy2ss6zf",
    });
  });

  it("defaults a path target branch to null", async () => {
    const { bb } = fakeBb();
    await expect(
      resolveEnvTarget(bb, { kind: "path", path: "/srv/app" }),
    ).resolves.toEqual({ kind: "path", path: "/srv/app", branch: null, hostId: null });
  });

  it("rejects a relative path target", async () => {
    const { bb } = fakeBb();
    await expect(
      resolveEnvTarget(bb, { kind: "path", path: "relative/dir" }),
    ).rejects.toThrow(EnvTargetError);
  });

  it("resolves a profile target through the store", async () => {
    const { bb } = fakeBb();
    await saveEnvProfile(bb, {
      name: "sre-uat",
      kind: "path",
      path: "/home/bb/projects/sre-uat",
      branch: "uat",
    });
    await expect(
      resolveEnvTarget(bb, { kind: "profile", profileId: "sre-uat" }),
    ).resolves.toEqual({
      kind: "path",
      path: "/home/bb/projects/sre-uat",
      branch: "uat",
      hostId: null,
    });
  });

  it("rejects an unknown profile", async () => {
    const { bb } = fakeBb();
    await expect(
      resolveEnvTarget(bb, { kind: "profile", profileId: "nope" }),
    ).rejects.toThrow(/No env profile/);
  });
});

describe("env profile store", () => {
  it("creates, finds by name and id, and lists sorted", async () => {
    const { bb } = fakeBb();
    const uat = await saveEnvProfile(bb, {
      name: "sre-uat",
      kind: "path",
      path: "/home/bb/projects/sre-uat/",
    });
    await saveEnvProfile(bb, {
      name: "Api worktree",
      kind: "reuse",
      environmentId: "env_9",
    });

    expect(uat.path).toBe("/home/bb/projects/sre-uat");
    expect(uat.environmentId).toBeNull();
    expect(uat.branch).toBeNull();

    const profiles = await listEnvProfiles(bb);
    expect(profiles.map((row) => row.name)).toEqual(["Api worktree", "sre-uat"]);

    expect((await findEnvProfile(bb, "SRE-UAT"))?.id).toBe(uat.id);
    expect((await findEnvProfile(bb, uat.id))?.name).toBe("sre-uat");
    expect(await findEnvProfile(bb, "missing")).toBeNull();
  });

  it("updates in place when an id is supplied", async () => {
    const { bb } = fakeBb();
    const created = await saveEnvProfile(bb, {
      name: "sre-uat",
      kind: "path",
      path: "/old",
    });
    const updated = await saveEnvProfile(bb, {
      id: created.id,
      name: "sre-uat",
      kind: "path",
      path: "/new",
      branch: "main",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.path).toBe("/new");
    expect(updated.branch).toBe("main");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(await listEnvProfiles(bb)).toHaveLength(1);
  });

  it("rejects a duplicate name on create", async () => {
    const { bb } = fakeBb();
    await saveEnvProfile(bb, { name: "sre-uat", kind: "path", path: "/a" });
    await expect(
      saveEnvProfile(bb, { name: "SRE-UAT", kind: "path", path: "/b" }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects a reuse profile with no environmentId", async () => {
    const { bb } = fakeBb();
    await expect(
      saveEnvProfile(bb, { name: "bad", kind: "reuse" }),
    ).rejects.toThrow(/environmentId/);
  });

  it("rejects a path profile with no path", async () => {
    const { bb } = fakeBb();
    await expect(
      saveEnvProfile(bb, { name: "bad", kind: "path" }),
    ).rejects.toThrow(/absolute path/);
  });

  it("deletes by name and reports a miss", async () => {
    const { bb } = fakeBb();
    await saveEnvProfile(bb, { name: "sre-uat", kind: "path", path: "/a" });
    expect(await deleteEnvProfile(bb, "SRE-UAT")).toBe(true);
    expect(await listEnvProfiles(bb)).toEqual([]);
    expect(await deleteEnvProfile(bb, "sre-uat")).toBe(false);
  });
});

describe("validateEnvTarget", () => {
  it("accepts a ready environment", async () => {
    const { bb } = fakeBb({
      environments: [
        {
          id: "env_1",
          name: "uat",
          projectId: "proj_1",
          hostId: "host_a",
          path: "/srv/uat",
          branchName: "uat",
          status: "ready",
          workspaceProvisionType: "unmanaged",
          isWorktree: false,
        },
      ],
    });
    await expect(
      validateEnvTarget(bb, { kind: "reuse", environmentId: "env_1" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a destroyed environment", async () => {
    const { bb } = fakeBb({
      environments: [
        {
          id: "env_1",
          name: null,
          projectId: "proj_1",
          hostId: "host_a",
          path: null,
          branchName: null,
          status: "destroyed",
          workspaceProvisionType: "managed-worktree",
          isWorktree: true,
        },
      ],
    });
    await expect(
      validateEnvTarget(bb, { kind: "reuse", environmentId: "env_1" }),
    ).rejects.toThrow(/destroyed/);
  });

  it("rejects an unknown environment", async () => {
    const { bb } = fakeBb();
    await expect(
      validateEnvTarget(bb, { kind: "reuse", environmentId: "env_missing" }),
    ).rejects.toThrow(/not readable/);
  });

  it("accepts a readable directory and rejects anything else", async () => {
    const { bb } = fakeBb({ readableDirs: ["/home/bb/projects/sre-uat"] });
    await expect(
      validateEnvTarget(bb, {
        kind: "path",
        path: "/home/bb/projects/sre-uat",
        branch: null,
        hostId: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateEnvTarget(bb, { kind: "path", path: "/nope", branch: null, hostId: null }),
    ).rejects.toThrow(/not a readable directory/);
  });

  it("is a no-op for the preset target", async () => {
    const { bb } = fakeBb();
    await expect(
      validateEnvTarget(bb, { kind: "preset" }),
    ).resolves.toBeUndefined();
  });
});

describe("default host resolution", () => {
  const projectSources = {
    proj_1: [
      { id: "src_1", hostId: "host_a", path: "/home/bb/plugins", isDefault: true },
      { id: "src_2", hostId: "host_b", path: "/elsewhere", isDefault: false },
    ],
    proj_2: [
      { id: "src_3", hostId: "host_b", path: "/srv", isDefault: false },
    ],
  };

  it("prefers the default source host", async () => {
    const { bb } = fakeBb({ projectSources });
    expect(await resolveDefaultHostId(bb, "proj_1")).toBe("host_a");
  });

  it("falls back to the first source when none is marked default", async () => {
    const { bb } = fakeBb({ projectSources });
    expect(await resolveDefaultHostId(bb, "proj_2")).toBe("host_b");
  });

  it("returns null for an unknown project", async () => {
    const { bb } = fakeBb({ projectSources });
    expect(await resolveDefaultHostId(bb, "proj_missing")).toBeNull();
  });

  it("fills in the host on a path target that named none", async () => {
    const { bb } = fakeBb({ projectSources });
    await expect(
      applyDefaultHost(
        bb,
        { kind: "path", path: "/srv/app", branch: null, hostId: null },
        "proj_1",
      ),
    ).resolves.toEqual({
      kind: "path",
      path: "/srv/app",
      branch: null,
      hostId: "host_a",
    });
  });

  it("keeps an explicit host", async () => {
    const { bb } = fakeBb({ projectSources });
    await expect(
      applyDefaultHost(
        bb,
        { kind: "path", path: "/srv/app", branch: null, hostId: "host_b" },
        "proj_1",
      ),
    ).resolves.toEqual({
      kind: "path",
      path: "/srv/app",
      branch: null,
      hostId: "host_b",
    });
  });

  it("leaves reuse and preset targets alone", async () => {
    const { bb } = fakeBb({ projectSources });
    await expect(
      applyDefaultHost(bb, { kind: "preset" }, "proj_1"),
    ).resolves.toEqual({ kind: "preset" });
    await expect(
      applyDefaultHost(bb, { kind: "reuse", environmentId: "env_1" }, "proj_1"),
    ).resolves.toEqual({ kind: "reuse", environmentId: "env_1" });
  });

  it("fails loudly when no host can be determined", async () => {
    const { bb } = fakeBb({ projectSources });
    await expect(
      applyDefaultHost(
        bb,
        { kind: "path", path: "/srv/app", branch: null, hostId: null },
        "proj_missing",
      ),
    ).rejects.toThrow(/Could not determine a host/);
  });

  it("checks the path on the named host", async () => {
    const { bb, fileListCalls } = fakeBb({ readableDirs: ["/srv/app"] });
    await validateEnvTarget(bb, {
      kind: "path",
      path: "/srv/app",
      branch: null,
      hostId: "host_b",
    });
    expect(fileListCalls[0]?.hostId).toBe("host_b");
  });
});

describe("toSpawnEnvironment", () => {
  it("maps a reuse target", () => {
    expect(
      toSpawnEnvironment({ kind: "reuse", environmentId: "env_1" }),
    ).toEqual({ type: "reuse", environmentId: "env_1" });
  });

  it("maps a path target without a branch", () => {
    expect(
      toSpawnEnvironment({ kind: "path", path: "/srv/uat", branch: null, hostId: null }),
    ).toEqual({
      type: "host",
      workspace: { type: "unmanaged", path: "/srv/uat" },
    });
  });

  it("maps a path target with an existing branch", () => {
    expect(
      toSpawnEnvironment({ kind: "path", path: "/srv/uat", branch: "uat", hostId: null }),
    ).toEqual({
      type: "host",
      workspace: {
        type: "unmanaged",
        path: "/srv/uat",
        branch: { kind: "existing", name: "uat" },
      },
    });
  });

  it("carries the host id when one is set", () => {
    expect(
      toSpawnEnvironment({
        kind: "path",
        path: "/srv/uat",
        branch: null,
        hostId: "host_a",
      }),
    ).toEqual({
      type: "host",
      hostId: "host_a",
      workspace: { type: "unmanaged", path: "/srv/uat" },
    });
  });
});

describe("describeEnvTarget", () => {
  it("describes each kind", () => {
    expect(describeEnvTarget({ kind: "preset" })).toBe("preset default");
    expect(
      describeEnvTarget({ kind: "reuse", environmentId: "env_1" }),
    ).toBe("existing environment env_1");
    expect(
      describeEnvTarget({ kind: "path", path: "/srv/uat", branch: null, hostId: null }),
    ).toBe("/srv/uat");
    expect(
      describeEnvTarget({ kind: "path", path: "/srv/uat", branch: "uat", hostId: null }),
    ).toBe("/srv/uat (branch uat)");
  });
});

describe("listEnvironmentOptions", () => {
  const environments: FakeEnvironment[] = [
    {
      id: "env_1",
      name: null,
      projectId: "proj_1",
      hostId: "host_a",
      path: "/home/bb/projects/sre-uat",
      branchName: "uat",
      status: "ready",
      workspaceProvisionType: "unmanaged",
      isWorktree: false,
    },
    {
      id: "env_2",
      name: "Alpha worktree",
      projectId: "proj_1",
      hostId: "host_a",
      path: "/home/bb/worktrees/alpha",
      branchName: "feature",
      status: "ready",
      workspaceProvisionType: "managed-worktree",
      isWorktree: true,
    },
    {
      id: "env_3",
      name: "Gone",
      projectId: "proj_2",
      hostId: "host_b",
      path: null,
      branchName: null,
      status: "destroyed",
      workspaceProvisionType: "personal",
      isWorktree: false,
    },
  ];

  const threads: FakeThread[] = [
    { id: "thr_a", projectId: "proj_1", environmentId: "env_1" },
    { id: "thr_b", projectId: "proj_1", environmentId: "env_1" },
    { id: "thr_c", projectId: "proj_1", environmentId: "env_2" },
    { id: "thr_d", projectId: "proj_2", environmentId: "env_3" },
    { id: "thr_e", projectId: "proj_1", environmentId: null },
    { id: "thr_f", projectId: "proj_1", environmentId: "env_missing" },
  ];

  it("dedupes, drops destroyed and unreadable rows, and sorts by name", async () => {
    const { bb } = fakeBb({ environments, threads });
    const rows = await listEnvironmentOptions(bb);
    expect(rows.map((row) => row.id)).toEqual(["env_2", "env_1"]);
    // env_1 has no name, so it falls back to the path basename.
    expect(rows[1].name).toBe("sre-uat");
    expect(rows[1].branchName).toBe("uat");
    expect(rows[1].hostId).toBe("host_a");
  });

  it("scopes to a bb project", async () => {
    const { bb, listCalls } = fakeBb({ environments, threads });
    const rows = await listEnvironmentOptions(bb, { bbProjectId: "proj_2" });
    expect(listCalls[0]?.projectId).toBe("proj_2");
    expect(rows).toEqual([]);
  });

  it("returns an empty list when nothing has an environment", async () => {
    const { bb } = fakeBb({ environments, threads: [] });
    expect(await listEnvironmentOptions(bb)).toEqual([]);
  });
});
