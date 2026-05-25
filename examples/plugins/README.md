# oh-my-warp example plugins

Sample plugins for Warp's JavaScript plugin host. See [`PLUGIN_SPEC.md`](../../PLUGIN_SPEC.md) for the full design and roadmap.

The host is enabled by the `omw_plugins` feature, which is on by default in oh-my-warp builds (patch *"Enable the JavaScript plugin host in the default build"*). At startup the app spawns the host process, which scans `~/.warp/plugins/*/` and runs each plugin's exported `activate(warp)`.

## `hello/` — Phase 0 sample

Logs a line through the host on startup, exercising the base API (`warp.version`, `warp.log`). This is the smallest end-to-end proof that third-party JS runs inside Warp.

### Install & run

```bash
mkdir -p ~/.warp/plugins
ln -s "$PWD/examples/plugins/hello" ~/.warp/plugins/hello   # or: cp -R
```

Launch oh-my-warp (via the Finder/launchd launcher, not from a dev shell), then check the logs:

```bash
grep -r "hello from oh-my-warp" ~/Library/Logs/
```

You should see the `activate()` output relayed from the host via the IPC `LogService`.

## `agent-browser/` — AI agent browser control

Exposes [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser) as AI agent tools (`warp.ai.registerTool`), so the agent can drive a real browser: open pages, snapshot the accessibility tree, click, type, read, and screenshot. Requires the `agent-browser` CLI (`brew install agent-browser && agent-browser install`). See [`agent-browser/README.md`](agent-browser/README.md). Install the same way as `hello` (symlink into `~/.warp/plugins/`).

## `sessionizer/` — project switcher

A [tmux-sessionizer](https://github.com/ThePrimeagen/tmux-sessionizer)-style project switcher: scans your dev roots (`~/repos`, `~/src`, …) and opens a picked project in a new tab. Command palette "Sessionizer: Switch Project" or the leader chord `ctrl-b f`. Uses `warp.ui.openProject(path)`. See [`sessionizer/README.md`](sessionizer/README.md).

## `claude-usage/` — token usage & cost (terminal + agent)

Track Claude Code usage in both surfaces: command palette ("Claude Usage: Today / This Month / Active Block", leader `ctrl-b u`) and an agent tool `claude_usage({period})`. Backed by [`ccusage`](https://github.com/ryoppippi/ccusage). Doubles as the template for a custom tool exposed in both terminal and agent modes. See [`claude-usage/README.md`](claude-usage/README.md).

## What works today (Phases 0–3)

- The host loads each plugin's **`main.js`** (compiled as an ES module) and calls **`export function activate(warp)`**.
- Base API: **`warp.version`** and **`warp.log(message, level?)`** (`level`: `"info"` | `"warn"` | `"error"`). A `console` global is also available.
- **`warp.commands.register(id, title, callback)`** — adds a command to the **command palette** (⌘P). Running it executes `callback`; a returned string is shown as a **toast**. Try *"Greet: Say Hello"* / *"Greet: Show Time"*.
- **`warp.terminal.onCommandStart(cb)` / `onCommandFinished(cb)`** — react to shell commands. `onCommandFinished` receives `{ command, exitCode, cwd, durationMs }`; a returned string is shown as a toast. The `hello` plugin logs every command and toasts when one **fails** or runs **≥3s** (try `false` or `sleep 4`).
- **`warp.ui.toast(message, kind?)`** — show a toast at any time (`kind`: `"info"` | `"warn"` | `"error"`). Try *"Greet: Toast (warp.ui.toast)"*.
- **`warp.keymap.bind(commandId, keys)`** — bind a key sequence to a command. The `hello` plugin binds *"Greet: Keybound Hello"* to the **`ctrl-b h`** leader chord; the user's `keybindings.yaml` overrides it.

The `plugin.json` manifest is parsed: `engines.warp` is enforced and `permissions` gate capability namespaces. Beyond the base API above, plugins can use **`warp.ai.registerTool`** (expose AI agent tools), **`warp.fs`** / **`warp.process`** / **`warp.network`** (capability-gated), and **`warp.ui.showMarkdown`** / **`showPalette`** / **`openWebTab`**. See [`PLUGIN_SPEC.md`](../../PLUGIN_SPEC.md) and the `agent-browser` plugin for examples.
