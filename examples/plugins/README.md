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

## What works today (Phases 0–3)

- The host loads each plugin's **`main.js`** (compiled as an ES module) and calls **`export function activate(warp)`**.
- Base API: **`warp.version`** and **`warp.log(message, level?)`** (`level`: `"info"` | `"warn"` | `"error"`). A `console` global is also available.
- **`warp.commands.register(id, title, callback)`** — adds a command to the **command palette** (⌘P). Running it executes `callback`; a returned string is shown as a **toast**. Try *"Greet: Say Hello"* / *"Greet: Show Time"*.
- **`warp.terminal.onCommandStart(cb)` / `onCommandFinished(cb)`** — react to shell commands. `onCommandFinished` receives `{ command, exitCode, cwd, durationMs }`; a returned string is shown as a toast. The `hello` plugin logs every command and toasts when one **fails** or runs **≥3s** (try `false` or `sleep 4`).
- **`warp.ui.toast(message, kind?)`** — show a toast at any time (`kind`: `"info"` | `"warn"` | `"error"`). Try *"Greet: Toast (warp.ui.toast)"*.
- **`warp.keymap.bind(commandId, keys)`** — bind a key sequence to a command. The `hello` plugin binds *"Greet: Keybound Hello"* to the **`ctrl-b h`** leader chord; the user's `keybindings.yaml` overrides it.

The `plugin.json` manifest is included for forward-compatibility but is **not parsed yet** — manifest discovery, `engines.warp` enforcement, declarative `contributes`, and `warp.ai` arrive in M4. See [`PLUGIN_SPEC.md`](../../PLUGIN_SPEC.md).
