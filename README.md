# Tasks Pro

Companion bb plugin for the official **Tasks** plugin. It does **not** patch or replace Tasks.

## What it does

Opens a dedicated panel where you can:

1. Browse **all** tasks, grouped by status or project. Search, Status / Priority / Label chips, and Sort (manual, priority, due date) match the official Tasks list. Optionally show only active agent work.
2. Click a row to open it; **All tasks** returns to the list.
3. Change status, priority, due date, and labels in place (Tasks `updateTask` RPC)
4. **Spin an agent** with a preset picker (default **Cursor Auto**) — same as `bb tasks dispatch`, plus a filtered **user + agent** comment pack in `extraInstructions` (skips system status rows that crowd Tasks' last-5 seed window)
5. Post a real Tasks comment (`createComment`), with optional notify (`--notify`)

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

## Install / reload

```sh
cd ~/Developer/bb-plugin-task-comment-float
bb plugin install . --yes
# after edits:
bb plugin build && bb plugin reload task-comment-float
```

Requires the official Tasks plugin enabled.

## Uninstall

```sh
bb plugin remove task-comment-float
```

Path installs leave the source tree on disk; only the install registration is removed.

## Why a companion (not an in-Tasks patch)

Third-party plugins cannot inject into Tasks’ React tree (`CommentComposer`, detail page). Host slots that *can* sit beside Tasks work (`navPanel`, `threadPanelAction`); there is no supported slot that overlays Tasks routes. A true sticky composer inside Tasks would be an upstream Tasks change.
