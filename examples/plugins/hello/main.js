// oh-my-warp — sample plugin.
//
// The plugin host compiles this file as an ES module and calls the exported
// `activate(warp)` once, on startup
// (app/src/plugin/host/native/runner.rs::run).
//
// API used here:
//   • warp.version             — semver of the warp.* API surface
//   • warp.log(message, level)  — level is "info" (default) | "warn" | "error"
//   • warp.commands.register(id, title, callback)
//        Adds a command to the command palette (Cmd-P). The string the callback
//        returns (if any) is shown to the user as a toast.
//   • warp.terminal.onCommandStart(cb)     — cb({ command, cwd })
//   • warp.terminal.onCommandFinished(cb)   — cb({ command, exitCode, cwd, durationMs })
//   • warp.ui.toast(message, kind?)         — kind is "info" (default) | "warn" | "error"
//   • warp.keymap.bind(commandId, keys)     — bind a key sequence to a command
//
// Log lines are relayed from the host to the app and land in Warp's normal log
// output (~/Library/Logs/warp-oss.log on macOS).

export function activate(warp) {
  warp.log(`hello from oh-my-warp! (warp.* API v${warp.version})`);

  // --- Command palette commands (M1) -------------------------------------
  warp.commands.register("greet.hello", "Greet: Say Hello", () => {
    warp.log("greet.hello command invoked");
    return "👋 Hello from the oh-my-warp plugin!";
  });

  warp.commands.register("greet.time", "Greet: Show Time", () => {
    return `Plugin says the time is ${new Date().toLocaleTimeString()}`;
  });

  // --- General toast via warp.ui.toast (M3) ------------------------------
  warp.commands.register(
    "greet.uitoast",
    "Greet: Toast (warp.ui.toast)",
    () => {
      warp.log("greet.uitoast invoked");
      warp.ui.toast("Hello via warp.ui.toast!", "warn");
    },
  );

  // --- Keybinding via warp.keymap.bind (M3) ------------------------------
  warp.commands.register("greet.keybound", "Greet: Keybound Hello", () => {
    warp.log("greet.keybound invoked");
    return "⌨️ ran via keybinding";
  });
  // Press the leader (ctrl-b) then "h" to run greet.keybound.
  warp.keymap.bind("greet.keybound", "ctrl-b h");

  // --- Terminal events (M2) ----------------------------------------------
  warp.terminal.onCommandStart((e) => {
    warp.log(`onCommandStart: ${e.command}`);
  });

  warp.terminal.onCommandFinished((e) => {
    warp.log(
      `onCommandFinished: ${e.command} (exit ${e.exitCode}, ${Math.round(e.durationMs)}ms)`,
    );
    if (e.exitCode !== 0) {
      return `✗ "${e.command}" exited ${e.exitCode}`;
    }
    if (e.durationMs >= 3000) {
      return `⏱ "${e.command}" took ${Math.round(e.durationMs / 1000)}s`;
    }
  });
}
