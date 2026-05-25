# Sessionizer plugin (oh-my-warp)

A [tmux-sessionizer](https://github.com/ThePrimeagen/tmux-sessionizer)-style project
switcher. Fuzzy-pick a repo under your dev roots and open it in a new tab with a
terminal rooted there.

- **Command palette** (`Cmd-P`): "Sessionizer: Switch Project"
- **Leader chord**: `ctrl-b f` (f = find project)

Backed by the `warp.ui.openProject(path)` plugin API (patch 0039), which opens a
new tab via `WorkspaceAction::OpenRepository`.

## How it works

At startup the plugin scans common dev roots under `$HOME` — `repos`, `src`,
`projects`, `work`, `code`, `dev`, `Developer`, `go/src` — for their immediate
subdirectories (your projects), via `find -mindepth 1 -maxdepth 1 -type d`. Each
becomes a "Project: <name>" command; the picker lists them all.

## Customizing

Edit `ROOT_NAMES` in `main.js` to change which directories are scanned. Projects
are discovered **once at startup** (the palette references pre-registered
commands), so **restart Warp after adding a new repo**.

## Install

Symlink into your Warp plugins directory (same as the other examples):

```sh
ln -sfn "$PWD/examples/plugins/sessionizer" ~/.warp/plugins/sessionizer
```

Then fully quit and relaunch Warp.
