# Claude Usage plugin (oh-my-warp)

Track Claude Code token usage and cost from **both** the terminal (command palette /
leader chord) and **agent mode** (an AI tool the agent can call). It's also the
reference template for "a custom tool available in both surfaces."

Data comes from [`ccusage`](https://github.com/ryoppippi/ccusage), which reads Claude
Code's local logs (`~/.claude/projects/**/*.jsonl`) — no API key needed.

## Terminal mode (Cmd-P / leader)

| Command | What |
|---------|------|
| **Claude Usage: Today** | today's tokens + cost (also `ctrl-b u`) |
| **Claude Usage: This Month** | the current month's totals |
| **Claude Usage: Active Block** | the live 5-hour billing window + projected cost |

Each opens a markdown panel.

## Agent mode

The agent gets a `claude_usage({period})` tool (`period`: `daily` \| `monthly` \|
`session` \| `blocks`). Ask things like *"how much have I spent on Claude this
month?"* or *"what's my token usage today?"* and it calls the tool and summarizes.

## Requirements

`ccusage` — install globally (`npm i -g ccusage`) for speed, or just have `npx` on
your PATH and the plugin will fall back to `npx ccusage` (downloads on first run).
The plugin resolves the binary by absolute path (nix / homebrew / npm-global / volta
/ bun locations), because Warp's GUI launch has a minimal `PATH`.

## Extending it (custom tools in both modes)

This plugin is a template. To add your own tool:

- **Terminal:** `panelCommand("my.tool", "My Tool: Thing", () => "# markdown")`
- **Agent:** `warp.ai.registerTool({ name, description, schema, run })`

See the `// --- add your own tools here ---` marker in `main.js`.

## Install

```sh
ln -sfn "$PWD/examples/plugins/claude-usage" ~/.warp/plugins/claude-usage
```

Then fully quit and relaunch Warp.
