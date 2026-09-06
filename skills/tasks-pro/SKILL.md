---
name: tasks-pro
description: Dispatch task agents onto a chosen checkout with the Tasks Pro `bb tasks-pro` CLI. Use when a task must run in a specific directory, branch, or existing bb environment; when a delegated agent lands in the wrong directory; or when listing, showing, commenting on, or updating tasks through Tasks Pro.
---

# Tasks Pro

Tasks Pro is a companion to the official Tasks plugin. It never forks the Tasks
UI and never writes the Tasks database directly. It reads and writes Tasks
through `bb.sdk.plugins.callRpc("tasks", …)`.

Use `bb tasks` for ordinary task work. Use `bb tasks-pro` when you need
env-aware dispatch, the filtered comment pack, or the richer list filters.

## Commands

| Command | Effect |
| --- | --- |
| `bb tasks-pro list [--status <s>]… [--priority <p>]… [--label <n>]… [--search <q>] [--project <id>] [--active] [--sort manual\|priority\|due] [--all]` | List tasks. |
| `bb tasks-pro show <key-or-id>` | Show one task with comments, attachments, threads, and the linked bb project. |
| `bb tasks-pro comment <key-or-id> --body <text> [--notify]` | Post a real Tasks comment. |
| `bb tasks-pro update <key-or-id> [--status <s>] [--priority <p>] [--due YYYY-MM-DD]` | Change task fields. |
| `bb tasks-pro assign <key-or-id> (--me \| --thread <thr_…> \| --preset <name>) [--no-notify]` | Record an assignee. |
| `bb tasks-pro dispatch <key-or-id> [--preset <name>] [env target] [--instructions <text>]` | Spin an agent. See below. |
| `bb tasks-pro envs [--project <proj_…>]` | List bb environments you can reuse. |
| `bb tasks-pro env-profiles` | List saved environment profiles. |
| `bb tasks-pro env-profile-set <name> (--env-id <id> \| --path <abs> [--branch <n>] [--host-id <id>]) [--project <proj_…>]` | Save or update a profile. |
| `bb tasks-pro env-profile-rm <name-or-id>` | Delete a profile. |

Add `--json` to any command when the output drives code.

## Env-aware dispatch

Tasks' `delegate` RPC can only pick `project-default` or `new-worktree`. A
shared checkout is unreachable that way, so the agent starts in the wrong
directory, calls `update_environment_directory` mid-turn, and stops for a
"continue". Naming an environment target avoids that stop.

`dispatch` takes at most one target:

| Flag | Effect |
| --- | --- |
| *(none)* | Tasks `delegate`. Unchanged behaviour. `--json` reports `"via":"delegate"`. |
| `--env-id <env_…>` | Reuse an existing bb environment. |
| `--path <abs>` | Spawn an unmanaged environment on that absolute host path. |
| `--branch <name>` | Existing branch. Only valid with `--path`. |
| `--host-id <host_…>` | Host for the path. Only valid with `--path`. Defaults to the host that owns the linked bb project. |
| `--profile <name>` | A saved profile holding one of the two targets above. |

An explicit target reports `"via":"spawn"` and the `environmentId` it used.

## Procedure

1. Run `bb tasks-pro show <key> --json` and read `project.linkedBbProjectId`.
   An explicit environment target fails without it.
2. Choose the target.
   - The task needs a specific checkout that bb does not manage yet: use
     `--path <abs>`, plus `--branch` when the work belongs on an existing
     branch.
   - The task should join an environment that already exists: run
     `bb tasks-pro envs --project <proj_…>`, then pass `--env-id`.
   - You dispatch to the same place often: save a profile once and pass
     `--profile`.
3. Dispatch with `--json` and check `via` and `environmentId` in the result.
4. Confirm the landing place from the agent's first comment or from
   `bb thread show <thr_…>`.

## Rules

- Scope environment lists with `--project`. `--env-id` only accepts an
  environment in the task's own bb project. bb refuses anything else with
  `HTTP 409: Environment belongs to a different project`, and nothing spawns.
- Pick an environment by path and branch, never by name. Most environments are
  named by the provider that created them, so names collide heavily.
- `--path` must be absolute, must exist, and must be a readable directory on
  the target host.
- `--branch` and `--host-id` need `--path`. Passing either alone is an error.
- Do not pass `--env-id` and `--path` together.
- Live dispatch starts a real agent thread. Use a scratch task when you test.
- The panel's **Environment target** select and these flags run the same server
  function. Either surface produces the same result for the same target.
