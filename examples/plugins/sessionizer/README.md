# Sessionizer plugin (oh-my-warp)

A [tmux-sessionizer](https://github.com/ThePrimeagen/tmux-sessionizer)-style project
switcher. Fuzzy-pick a **git repo** under your dev roots and **switch to it**: if a
tab rooted at that repo is already open it is focused, otherwise a new tab with a
terminal there is opened (switch-or-create).

- **Command palette** (`Cmd-P`): "Sessionizer: Switch Project"
- **Leader chord**: `ctrl-b f` (f = find project)

## How it works

Each time you invoke it, the plugin **re-scans** your roots for git repositories
(directories containing a `.git` one level down: `find <root> -mindepth 2 -maxdepth
2 -name .git`), so repos created after Warp launched show up without a restart. The
picker is a `showPalette` whose items carry the `warp:openProject:<path>` sentinel;
the app resolves it via patch 0039's `OpenProject` handler, which **focuses an
existing tab for that repo if one is open** (matching a terminal whose cwd is the
repo or a subdirectory) and otherwise opens a new one.

It does **not** register a command per project — doing that from inside the picker's
own command callback would re-enter the plugin host and crash it. So the only
command it adds is "Sessionizer: Switch Project".

## Customizing roots

By default it scans these under `$HOME` (only those that exist): `repos`, `src`,
`projects`, `work`, `code`, `dev`, `Developer`, `go/src`. To override, create
`~/.warp/oh-my-warp/sessionizer-roots.txt` with **one directory per line** (a
leading `~/` is expanded; blank lines and `#`-comments are ignored). A non-empty
config file fully replaces the defaults.

## Install

Symlink into your Warp plugins directory (same as the other examples):

```sh
ln -sfn "$PWD/examples/plugins/sessionizer" ~/.warp/plugins/sessionizer
```

Then fully quit and relaunch Warp.
