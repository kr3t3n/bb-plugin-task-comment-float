# Tasks Pro

Companion bb plugin for the official **Tasks** plugin. It does **not** patch or replace Tasks.

## What it does

Opens a dedicated panel where you can:

1. Browse **all** tasks, grouped by status or project. Search, Status / Priority / Label chips, and Sort (manual, priority, due date) match the official Tasks list. Optionally show only active agent work.
2. Click a row to open it; **All tasks** returns to the list.
3. Change status, priority, due date, and labels in place (Tasks `updateTask` RPC)
4. **Spin an agent** with a preset picker (default **Cursor Auto**) — same as `bb tasks dispatch`, plus a filtered **user + agent** comment pack in `extraInstructions` (skips system status rows that crowd Tasks' last-5 seed window)
5. **Land the agent on a chosen checkout** — see [Env-aware dispatch](#env-aware-dispatch)
6. Post a real Tasks comment (`createComment`), with optional notify (`--notify`)

## Open

- Sidebar → **Tasks Pro** (nav panel), or deep link `/plugins/task-comment-float/compose/PRO-1`
- On Tasks Pro: right **Navigation** fixed tab (All / Active / projects + New task / New project). Coexists with host Browser / Terminal tabs on that page.
- **In a thread:** Tasks Pro auto-opens once as a peer tab in the shared right panel (with Terminal / Browser / files). After that it stays until you close the tab or the panel; we do not keep re-focusing it when you switch tabs. Reopen via header **Tasks Pro** or Actions → Tasks Pro.
- New thread → Actions → **Tasks Pro** opens the same peer tab

## CLI (same bridge as the UI)

```sh
bb tasks-pro list --status in_progress --sort priority
bb tasks-pro show PRO-1
bb tasks-pro comment PRO-1 --body "…" [--notify]
bb tasks-pro update PRO-1 --status in_review --priority high
bb tasks-pro dispatch PRO-1                 # Cursor Auto
bb tasks-pro dispatch PRO-1 --preset "Opus High"
```

## Env-aware dispatch

### Why this exists

Tasks' own `delegate` RPC picks the environment from the preset's
`environmentKind`, which is only `project-default` or `new-worktree`. A shared
checkout such as `/home/bb/projects/sre-uat` is unreachable that way.

The agent then starts in the wrong directory. It notices the mismatch mid-turn,
calls `update_environment_directory`, and stops. You have to type "continue" to
restart it, and the first turn is wasted. Env-aware dispatch removes that stop:
the agent starts in the checkout you named.

Tasks Pro adds two explicit targets. When you name one, it spawns the thread
itself with `bb.sdk.threads.spawn` and attaches it back to the task through the
Tasks `taskThreadsAttach` RPC. The seed prompt is rebuilt with the same
sections Tasks would have sent, plus the filtered comment pack and an
**Environment** section that tells the agent it is already in the right place:

```text
## Environment

You are running in the checkout at /home/bb/projects/sre-uat.
The environment is on the existing branch uat/integration-sre9-14.
This is already the right working directory. Do not call
`update_environment_directory` and do not stop to ask for a directory change.
```

With no environment flag, dispatch still calls Tasks `delegate` unchanged.

### CLI flags

`bb tasks-pro dispatch <key-or-id>` takes at most one environment target.

| Flag | Effect |
| --- | --- |
| *(none)* | Tasks `delegate`. The preset's `environmentKind` decides. Unchanged behaviour. |
| `--env-id <env_…>` | Reuse an existing bb environment. |
| `--path <abs>` | Spawn an unmanaged environment on that absolute host path. |
| `--branch <name>` | Check out an existing branch. Only valid with `--path`. |
| `--host-id <host_…>` | Host for a `--path` target. Only valid with `--path`. |
| `--profile <name>` | Use a saved profile, which holds one of the two targets above. |
| `--preset <name>` | Agent preset. Defaults to Cursor Auto. |
| `--instructions <text>` | Extra text appended to the seed prompt. |
| `--json` | Machine output, including `via` and `environmentId`. |

```sh
# reuse an existing bb environment
bb tasks-pro dispatch PRO-1 --env-id env_ufiu6uxtrk

# land on an absolute host path, optionally on an existing branch
bb tasks-pro dispatch PRO-1 --path /home/bb/projects/sre-uat
bb tasks-pro dispatch PRO-1 --path /home/bb/projects/sre-uat --branch uat

# use a saved profile
bb tasks-pro dispatch PRO-1 --profile sre-uat
```

`--json` reports which route ran:

```json
{"ok":true,"threadId":"thr_adejd5cq3f","preset":"Worker - Cursor Auto Medium",
 "via":"spawn","environmentId":"env_7hkhgfu9pd"}
```

`via` is `delegate` for the preset default and `spawn` for an explicit target.

Omit `--host-id` and Tasks Pro uses the host that owns the linked bb project's
default source.

### Spin agent env controls

The panel exposes the same four targets. Under the **Spin agent** preset select
sits an **Environment target** select with these options:

| Option | CLI equivalent |
| --- | --- |
| Preset default | no flag |
| Environment profile | `--profile <name>` |
| Existing environment | `--env-id <env_…>` |
| Absolute path | `--path <abs>` (plus a second field for `--branch`) |

Picking a kind reveals the field it needs: a profile select, an environment
select, or a path field and an optional branch field. A one-line summary under
the controls names the landing place, and turns red with the reason when the
draft is incomplete. **Spin agent** stays disabled until the draft is valid.

The controls render in both places the Spin agent button appears: the right
properties rail on the task detail view (stacked), and the compose bar (inline
on wide screens). Each preset remembers its last environment target in
`localStorage`, so a preset you always run on a UAT checkout keeps that target.
Choosing **Preset default** clears the stored value.

The panel and the CLI share one server function, `runDispatch` in `server.ts`,
so the two surfaces cannot drift. The panel sends the `envTarget` field of the
`dispatch` RPC; the CLI builds the same field from its flags.

### Environment profiles

Name a target once and reuse it:

```sh
bb tasks-pro envs [--project proj_dcf7pm7baf]   # environments you can reuse
bb tasks-pro env-profiles
bb tasks-pro env-profile-set sre-uat --path /home/bb/projects/sre-uat
bb tasks-pro env-profile-set api-wt --env-id env_ufiu6uxtrk
bb tasks-pro env-profile-rm sre-uat
```

Profiles live in the plugin's KV storage. `--project proj_…` scopes a profile
to one bb project; omit it for a profile that applies everywhere.

`bb tasks-pro envs` derives its list from the environments referenced by recent
threads, because the plugin SDK exposes `environments.get` but no
`environments.list`. An environment with no threads will not appear — use
`--path` for those.

**The name does not identify an environment.** Most environments are named by
the provider that created them, so they collide heavily: on this host 34 of 36
are called `claude-env`. Pick by path and branch, not by name. `bb tasks-pro
envs` prints `id  status  host  name  path @branch` for that reason, and the
Spin agent picker labels each row `name · branch-or-path`.

### Requirements and validation

An explicit environment target needs the Tasks project to have a linked bb
project (`linkedBbProjectId`). Tasks Pro checks before spawning that the path
is absolute, exists, and is a readable directory on the target host, and that a
reused environment is not retiring or destroyed.

**`--env-id` only accepts an environment in the task's own bb project.** bb
refuses a cross-project reuse with `HTTP 409: Environment belongs to a
different project`, and nothing spawns. Scope the list before you pick:

```sh
bb tasks-pro envs --project proj_dcf7pm7baf
```

`--path` has no such limit. It creates a new unmanaged environment inside the
task's bb project, so use it for any checkout that project does not own yet.

## Tests and smoke

```sh
npm test         # vitest: env targets, profiles, seed prompt (68 tests)
npm run typecheck
```

`scripts/smoke-env-dispatch.sh` drives the shipped CLI against a running bb
daemon. It has two modes.

```sh
# Safe mode. Env discovery, profile CRUD, every input-validation path.
# Spawns no agents.
./scripts/smoke-env-dispatch.sh

# Live mode. Also dispatches one scratch task per target kind.
# This starts three real agent threads.
TPRO3_SMOKE_PATH=/home/bb/tmp/scratch \
  ./scripts/smoke-env-dispatch.sh --spawn TPRO-7 --preset "Worker - Cursor Auto Medium"
```

Set `TPRO3_SMOKE_PATH` to a scratch checkout. The default lands an agent in
this plugin's own source tree. Use a scratch task whose description tells the
agent to run `pwd`, comment the result, and stop.

Live mode runs the path kind before the reuse kind on purpose. The path
dispatch creates an unmanaged environment inside the task's bb project, which
the reuse dispatch can then target. See the cross-project rule above.

### Manual checklist

Run these four after any change to dispatch, and confirm the landing place from
the `pwd` the agent comments back.

1. **Project default.** `bb tasks-pro dispatch <key>` with no environment flag.
   Expect `"via":"delegate"` and the project's own directory.
2. **Absolute path.** `--path <abs> [--branch <name>]`. Expect `"via":"spawn"`,
   a new environment id, and `pwd` equal to the path. The agent must not call
   `update_environment_directory` and must not stop for a "continue".
3. **Reuse.** `--env-id <env_…>` for an environment in the same bb project.
   Expect `"via":"spawn"` and the same environment id you passed.
4. **Panel.** Open the task in Tasks Pro. Check the **Environment target**
   select under **Spin agent**, switch between all four kinds, and confirm the
   summary line and the disabled **Spin agent** button behave as described in
   [Spin agent env controls](#spin-agent-env-controls). The panel result must
   match the CLI result for the same target.

## Install / reload

Path install from the plugins tree on this host:

```sh
cd /home/bb/plugins/bb-plugin-task-comment-float
bb plugin install . --yes
# after edits:
bb plugin build && bb plugin reload task-comment-float
```

The source lives on GitHub at
[`kr3t3n/bb-plugin-task-comment-float`](https://github.com/kr3t3n/bb-plugin-task-comment-float).
Install from a clone the same way:

```sh
git clone https://github.com/kr3t3n/bb-plugin-task-comment-float
bb plugin install ./bb-plugin-task-comment-float --yes
```

Requires the official Tasks plugin enabled.

## Uninstall

```sh
bb plugin remove task-comment-float
```

Path installs leave the source tree on disk; only the install registration is removed.

## Why a companion (not an in-Tasks patch)

Third-party plugins cannot inject into Tasks’ React tree (`CommentComposer`, detail page). Host slots that *can* sit beside Tasks work (`navPanel`, `threadPanelAction`); there is no supported slot that overlays Tasks routes. A true sticky composer inside Tasks would be an upstream Tasks change.
