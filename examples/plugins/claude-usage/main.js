// oh-my-warp — Claude Usage plugin.
//
// Tracks Claude Code token usage + cost in BOTH surfaces:
//   • Terminal mode (Cmd-P / leader): "Claude Usage: Today / This Month / Active Block"
//     show a markdown panel; the leader chord ctrl-b u opens today's usage.
//   • Agent mode: the `claude_usage({period})` tool returns the raw ccusage JSON so
//     the agent can reason about your spend.
//
// Data comes from `ccusage` (https://github.com/ryoppippi/ccusage), which reads
// Claude Code's local logs (~/.claude/projects/**/*.jsonl). The plugin resolves the
// `ccusage` binary by absolute path (the app's GUI launch has a minimal PATH that
// omits nix/brew/npm bin dirs — see the agent-browser plugin for the same lesson),
// falling back to `npx ccusage` if no global install is found.
//
// This file also doubles as the template for "a custom tool available in both
// terminal and agent modes": see `panelCommand` (terminal) + `warp.ai.registerTool`
// (agent), and the `// --- add your own tools here ---` marker below.
//
// Capabilities (manifest `permissions`): commands, ai, process, ui.

export function activate(warp) {
  const INSTALL_HINT =
    "ccusage not found. Install with `npm i -g ccusage` (or have `npx` on PATH " +
    "and it will use `npx ccusage`). See https://github.com/ryoppippi/ccusage";

  // --- resolve a ccusage runner (absolute path; no login shell) ----------------
  // Returns an argv prefix: e.g. ["/abs/ccusage"] or ["/abs/npx","-y","ccusage@latest"].
  let RUNNER; // undefined = unresolved, null = unavailable, string[] = runner prefix
  function runner() {
    if (RUNNER !== undefined) return RUNNER;
    const home = (warp.plugin.dir || "").split("/.warp/")[0] || "";
    const user = home.split("/").pop() || "";
    const runs = (bin, args) => {
      try {
        return warp.process.exec(bin, args).code === 0;
      } catch (_) {
        return false;
      }
    };
    const binDirs = [
      "", // bare name (works if the app inherited a full PATH)
      home && `${home}/.nix-profile/bin/`,
      "/run/current-system/sw/bin/",
      user && `/etc/profiles/per-user/${user}/bin/`,
      "/opt/homebrew/bin/",
      "/usr/local/bin/",
      home && `${home}/.bun/bin/`,
      home && `${home}/.local/bin/`,
      home && `${home}/.volta/bin/`,
    ].filter((d) => d !== false && d !== undefined);

    // 1) a global `ccusage`.
    for (const dir of binDirs) {
      const bin = `${dir}ccusage`;
      if (runs(bin, ["--version"])) {
        RUNNER = [bin];
        return RUNNER;
      }
    }
    // 2) fall back to `npx ccusage` (downloads on first run).
    for (const dir of binDirs) {
      const npx = `${dir}npx`;
      if (runs(npx, ["--version"])) {
        RUNNER = [npx, "-y", "ccusage@latest"];
        return RUNNER;
      }
    }
    RUNNER = null;
    return RUNNER;
  }

  // Run `ccusage <args> --json`; returns parsed JSON, or `{ error }`.
  function ccusage(args) {
    const prefix = runner();
    if (!prefix) return { error: INSTALL_HINT };
    let res;
    try {
      res = warp.process.exec(prefix[0], [
        ...prefix.slice(1),
        ...args,
        "--json",
      ]);
    } catch (e) {
      return { error: INSTALL_HINT, detail: String(e) };
    }
    if (res.code !== 0) {
      return { error: (res.stderr || res.stdout || "ccusage failed").trim() };
    }
    try {
      return JSON.parse(res.stdout || "{}");
    } catch (_) {
      return { error: "could not parse ccusage output" };
    }
  }

  // --- formatting helpers ------------------------------------------------------
  const n = (x) => (typeof x === "number" ? x.toLocaleString("en-US") : "0");
  const usd = (x) => `$${(typeof x === "number" ? x : 0).toFixed(2)}`;
  const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local-ish)

  function row(label, e) {
    if (!e) return `**${label}:** no usage\n`;
    const models = (e.modelsUsed || [])
      .map((m) => m.replace(/-\d{8}$/, ""))
      .join(", ");
    return (
      `**${label}** — ${usd(e.totalCost)} · ${n(e.totalTokens)} tokens` +
      `\n  - in ${n(e.inputTokens)} / out ${n(e.outputTokens)} / ` +
      `cache-write ${n(e.cacheCreationTokens)} / cache-read ${n(e.cacheReadTokens)}` +
      (models ? `\n  - models: ${models}` : "") +
      "\n"
    );
  }

  function dailyPanel() {
    const data = ccusage(["daily"]);
    if (data.error) return `# Claude usage\n\n${data.error}`;
    const days = data.daily || [];
    const t = today();
    const entry = days.find((d) => d.date === t) || days[days.length - 1];
    const heading = entry ? `Today (${entry.date})` : "Today";
    return `# Claude usage — ${heading}\n\n${row(heading, entry)}`;
  }

  function monthlyPanel() {
    const data = ccusage(["monthly"]);
    if (data.error) return `# Claude usage\n\n${data.error}`;
    const months = data.monthly || [];
    const entry = months[months.length - 1];
    const label = entry ? `Month (${entry.month})` : "This month";
    return `# Claude usage — ${label}\n\n${row(label, entry)}`;
  }

  function blockPanel() {
    const data = ccusage(["blocks", "--active"]);
    if (data.error) return `# Claude usage\n\n${data.error}`;
    const block =
      (data.blocks || []).find((b) => b.isActive) || (data.blocks || [])[0];
    if (!block)
      return "# Claude usage — active block\n\nNo active 5-hour block.";
    // NB: blocks use different field names than daily/monthly (costUSD,
    // tokenCounts.*, models, burnRate, projection).
    const tc = block.tokenCounts || {};
    const burn = block.burnRate || {};
    const proj = block.projection || {};
    const models = (block.models || [])
      .map((m) => m.replace(/-\d{8}$/, ""))
      .join(", ");
    let out =
      "# Claude usage — active 5-hour block\n\n" +
      `**So far** — ${usd(block.costUSD)} · ${n(block.totalTokens)} tokens\n` +
      `  - in ${n(tc.inputTokens)} / out ${n(tc.outputTokens)} / ` +
      `cache-write ${n(tc.cacheCreationInputTokens)} / cache-read ${n(tc.cacheReadInputTokens)}\n`;
    if (models) out += `  - models: ${models}\n`;
    if (burn.costPerHour != null)
      out += `  - burn rate: ${usd(burn.costPerHour)}/hr\n`;
    if (proj.totalCost != null)
      out +=
        `\n**Projected (end of block):** ${usd(proj.totalCost)}` +
        (proj.remainingMinutes != null
          ? ` · ${proj.remainingMinutes} min left`
          : "");
    return out;
  }

  // Register a Cmd-P command that renders a markdown panel from `build()`.
  function panelCommand(id, title, build) {
    warp.commands.register(id, title, () =>
      warp.ui.showMarkdown(title, build()),
    );
  }

  // --- Terminal mode: command-palette entries ----------------------------------
  panelCommand("claudeUsage.today", "Claude Usage: Today", dailyPanel);
  panelCommand("claudeUsage.month", "Claude Usage: This Month", monthlyPanel);
  panelCommand("claudeUsage.block", "Claude Usage: Active Block", blockPanel);

  // Leader chord: ctrl-b u -> today's usage.
  warp.keymap.bind("claudeUsage.today", "ctrl-b u");

  // --- Agent mode: a tool the AI can call --------------------------------------
  warp.ai.registerTool({
    name: "claude_usage",
    description:
      "Report the user's Claude Code token usage and cost (from ccusage, which reads " +
      "~/.claude logs). Use when asked about Claude/Anthropic usage, spend, cost, or " +
      "token consumption. Returns ccusage JSON for the requested period.",
    schema: JSON.stringify({
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["daily", "monthly", "session", "blocks"],
          description:
            "Aggregation period (default daily). 'blocks' = 5-hour billing windows.",
        },
      },
    }),
    run: (argsJson) => {
      let period = "daily";
      try {
        const a = JSON.parse(argsJson || "{}");
        if (a.period) period = String(a.period);
      } catch (_) {
        /* default */
      }
      const allowed = ["daily", "monthly", "session", "blocks"];
      if (!allowed.includes(period)) period = "daily";
      const data = ccusage([period]);
      return JSON.stringify(data);
    },
  });

  // --- Native prompt segment: live "today" cost (warp.prompt) ------------------
  // Pushes a right-grouped chip with today's spend into Warp's native prompt and
  // refreshes it after commands finish (throttled), so it tracks usage as you work.
  // Degrades gracefully on a Warp without `warp.prompt` / `warp.terminal`.
  function todayCostText() {
    const data = ccusage(["daily"]);
    if (data.error) return null;
    const days = data.daily || [];
    const t = today();
    const entry = days.find((d) => d.date === t) || days[days.length - 1];
    return entry ? usd(entry.totalCost) : null;
  }

  function refreshPromptSegment() {
    if (!warp.prompt) return;
    const cost = todayCostText();
    if (cost == null) {
      warp.prompt.clear();
      return;
    }
    warp.prompt.set([
      {
        text: `claude ${cost}`,
        side: "right",
        tooltip: "Claude usage today (ccusage)",
      },
    ]);
  }

  if (warp.prompt) {
    refreshPromptSegment(); // show it right away
    if (warp.terminal && warp.terminal.onCommandFinished) {
      let lastPromptRefresh = 0;
      warp.terminal.onCommandFinished(() => {
        const now = Date.now();
        if (now - lastPromptRefresh < 30000) return; // at most once per 30s
        lastPromptRefresh = now;
        refreshPromptSegment();
      });
    }
  }

  // --- add your own tools here -------------------------------------------------
  // Pattern: `panelCommand(id, title, () => "# markdown")` for a terminal command,
  // and/or `warp.ai.registerTool({ name, description, schema, run })` for the agent.

  warp.log(
    runner()
      ? "Claude Usage ready (ctrl-b u, or ask the agent about your Claude usage)"
      : "Claude Usage: ccusage not found; install it to enable usage tracking",
  );
}
