// oh-my-warp — Claude Usage plugin.
//
// Tracks Claude Code token usage + cost in BOTH surfaces:
//   • Terminal mode (Cmd-P / leader): "Claude Usage: Today / This Month / Active Block"
//     show a markdown panel; the leader chord ctrl-b u opens today's usage.
//   • Agent mode: the `claude_usage({period})` tool returns the raw ccusage JSON so
//     the agent can reason about your spend.
//
// Data comes from `ccusage` (https://github.com/ryoppippi/ccusage), which reads
// Claude Code's local logs (~/.claude/projects/**/*.jsonl).
//
// PERFORMANCE — why this plugin caches:
//   ccusage parses *all* of your ~/.claude logs on every run, which for a heavy
//   user is ~13s — and `warp.process.exec` is SYNCHRONOUS, so a direct call freezes
//   the whole (shared) plugin host for those 13s. That stalled startup and made
//   every other plugin feel laggy. So we never call ccusage on a path the user is
//   waiting on. Instead:
//     • a detached background process (`sh -c '( … ) &'`, which returns in ~5ms)
//       runs ccusage and atomically writes a small JSON cache file, and
//     • every UI path (panels, prompt chip, agent tool) reads that cache INSTANTLY.
//   The data is at most one refresh-cycle stale (fine for a cost readout), and the
//   host is never blocked. First run shows a "computing…" note until the first
//   background refresh lands (~15s), then it's instant forever after.
//
// This file also doubles as the template for "a custom tool available in both
// terminal and agent modes": see `panelCommand` (terminal) + `warp.ai.registerTool`
// (agent), and the `// --- add your own tools here ---` marker below.
//
// Capabilities (manifest `permissions`): commands, ai, process, ui, terminal:events.

export function activate(warp) {
  const INSTALL_HINT =
    "ccusage not found. Install with `npm i -g ccusage` (or have `npx` on PATH " +
    "and it will use `npx ccusage`). See https://github.com/ryoppippi/ccusage";
  const COMPUTING_MSG =
    "# Claude usage\n\n_Scanning your Claude logs in the background (the first " +
    "run can take ~15s). Reopen this in a moment — after that it's instant._";

  // --- paths: a per-period JSON cache under ~/.warp/oh-my-warp/cache ------------
  const home = (warp.plugin.dir || "").split("/.warp/")[0] || "";
  const CACHE_DIR = home ? `${home}/.warp/oh-my-warp/cache` : "/tmp";
  const cacheFile = (period) => `${CACHE_DIR}/claude-usage-${period}.json`;
  // Single-quote a token for safe inclusion in a `sh -c` string.
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  // --- resolve a ccusage runner (absolute path; no login shell) ----------------
  // Returns an argv prefix: e.g. ["/abs/ccusage"] or ["/abs/npx","-y","ccusage@latest"].
  let RUNNER; // undefined = unresolved, null = unavailable, string[] = runner prefix
  function runner() {
    if (RUNNER !== undefined) return RUNNER;
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

    // 1) a global `ccusage` (probing --version is cheap; it doesn't scan logs).
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

  // The ccusage subcommand+flags for a period.
  function periodArgs(period) {
    if (period === "monthly") return ["monthly"];
    if (period === "blocks") return ["blocks", "--active"];
    if (period === "session") return ["session"];
    return ["daily"];
  }

  // --- cache I/O via `process` (the manifest grants no fs) ----------------------
  // Read the cached ccusage JSON for a period (instant), or null if absent/bad.
  function readCache(period) {
    try {
      const res = warp.process.exec("/bin/cat", [cacheFile(period)]);
      if (res.code !== 0 || !res.stdout) return null;
      return JSON.parse(res.stdout);
    } catch (_) {
      return null;
    }
  }

  // Mtime of the cache file as a "Nm ago" string, or "" if unavailable.
  function cacheAge(period) {
    try {
      const res = warp.process.exec("/usr/bin/stat", [
        "-f",
        "%m",
        cacheFile(period),
      ]);
      const mtime = parseInt((res.stdout || "").trim(), 10);
      if (!res || res.code !== 0 || !mtime) return "";
      const age = Math.max(0, Math.floor(Date.now() / 1000) - mtime);
      const ago =
        age < 60
          ? `${age}s`
          : age < 3600
            ? `${Math.floor(age / 60)}m`
            : `${Math.floor(age / 3600)}h`;
      return `\n\n_Updated ${ago} ago · refreshing in the background._`;
    } catch (_) {
      return "";
    }
  }

  // Kick a detached background refresh that writes the cache atomically. Returns
  // immediately (~5ms): the heavy ccusage run happens in an orphaned subshell, so
  // the plugin host is never blocked. `minIntervalMs` throttles redundant kicks.
  const lastBg = {}; // period -> last-kick epoch ms
  function bgRefresh(period, minIntervalMs) {
    const prefix = runner();
    if (!prefix) return;
    const now = Date.now();
    if (minIntervalMs && lastBg[period] && now - lastBg[period] < minIntervalMs)
      return;
    lastBg[period] = now;
    const cache = cacheFile(period);
    // Live pricing (no --offline): bundled offline pricing can't price the newest
    // models and silently reports $0, and --offline saves no time anyway (ccusage's
    // cost is log parsing, not the pricing fetch). The refresh is backgrounded, so
    // any network latency doesn't reach the user.
    const argv = [...prefix, ...periodArgs(period), "--json"]
      .map(shq)
      .join(" ");
    // mkdir -p; run ccusage into a per-process temp file ($$ = subshell pid, so two
    // concurrent refreshes can't corrupt each other); atomically move it into place.
    const script =
      `mkdir -p ${shq(CACHE_DIR)} && t=${shq(cache)}.$$.tmp && ` +
      `${argv} > "$t" 2>/dev/null && mv -f "$t" ${shq(cache)} || rm -f "$t"`;
    try {
      warp.process.exec("/bin/sh", ["-c", `( ${script} ) >/dev/null 2>&1 &`]);
    } catch (_) {
      /* refresh is best-effort */
    }
  }

  // Blocking ccusage run — only used as a last resort for the agent tool on the
  // very first request before any cache exists. Freezes the host (~13s), so it is
  // NOT used by any interactive UI path.
  function ccusageBlocking(period) {
    const prefix = runner();
    if (!prefix) return { error: INSTALL_HINT };
    let res;
    try {
      res = warp.process.exec(prefix[0], [
        ...prefix.slice(1),
        ...periodArgs(period),
        "--json",
      ]);
    } catch (e) {
      return { error: INSTALL_HINT, detail: String(e) };
    }
    if (res.code !== 0)
      return { error: (res.stderr || res.stdout || "ccusage failed").trim() };
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

  // Serve a panel from cache (instant); kick a background refresh so the next open
  // is fresh. Shows an install hint if ccusage is missing, or a "computing" note on
  // the very first run before the cache lands.
  function servePanel(period, build) {
    if (!runner()) return `# Claude usage\n\n${INSTALL_HINT}`;
    bgRefresh(period, 0); // explicit open: always refresh for next time
    const data = readCache(period);
    if (!data) return COMPUTING_MSG;
    if (data.error) return `# Claude usage\n\n${data.error}`;
    return build(data) + cacheAge(period);
  }

  function dailyPanel() {
    return servePanel("daily", (data) => {
      const days = data.daily || [];
      const t = today();
      const entry = days.find((d) => d.date === t) || days[days.length - 1];
      const heading = entry ? `Today (${entry.date})` : "Today";
      return `# Claude usage — ${heading}\n\n${row(heading, entry)}`;
    });
  }

  function monthlyPanel() {
    return servePanel("monthly", (data) => {
      const months = data.monthly || [];
      const entry = months[months.length - 1];
      const label = entry ? `Month (${entry.month})` : "This month";
      return `# Claude usage — ${label}\n\n${row(label, entry)}`;
    });
  }

  function blockPanel() {
    return servePanel("blocks", (data) => {
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
    });
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
      bgRefresh(period, 0); // keep the cache warm for next time
      // Prefer the cache (instant); only fall back to a blocking run if nothing is
      // cached yet (first request of a fresh session) so the agent still gets data.
      const data = readCache(period) || ccusageBlocking(period);
      return JSON.stringify(data);
    },
  });

  // --- Native prompt segment: live "today" cost (warp.prompt) ------------------
  // Pushes a right-grouped chip with today's spend into Warp's native prompt and
  // refreshes it after commands finish (throttled). Reads the cache instantly —
  // the actual ccusage run happens in the background — so it never blocks the host.
  // Degrades gracefully on a Warp without `warp.prompt` / `warp.terminal`.
  function todayCostText() {
    const data = readCache("daily");
    if (!data || data.error) return null;
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
    // kind picks the chip color from theme.ansi_fg_* so the chip follows the
    // active terminal theme. `icon` renders as a short sigil prefix.
    warp.prompt.set([
      {
        text: cost,
        icon: "🧠",
        side: "right",
        kind: "accent",
        tooltip: "Claude usage today (ccusage, cached)",
      },
    ]);
  }

  if (warp.prompt) {
    bgRefresh("daily", 0); // kick the first fetch in the background (non-blocking)
    refreshPromptSegment(); // show the cached value instantly if one exists
    if (warp.terminal && warp.terminal.onCommandFinished) {
      let lastChipRefresh = 0;
      warp.terminal.onCommandFinished(() => {
        const now = Date.now();
        if (now - lastChipRefresh < 15000) return; // re-read the chip at most every 15s
        lastChipRefresh = now;
        bgRefresh("daily", 60000); // refresh the data in the background at most once/min
        refreshPromptSegment(); // re-read the (instant) cache into the chip
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
