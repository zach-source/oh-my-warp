// oh-my-warp — Phase 0 sample plugin.
//
// The plugin host compiles this file as an ES module and calls the exported
// `activate(warp)` once, on startup
// (app/src/plugin/host/native/runner.rs::run).
//
// Phase 0 exposes only the always-present base API:
//   • warp.version            — semver of the warp.* API surface
//   • warp.log(message, level) — level is "info" (default) | "warn" | "error"
//
// Log lines are relayed from the host process to the app via the IPC
// LogService and land in Warp's normal log output.
//
// (A `console` global with console.log/console.err is also available.)

export function activate(warp) {
  warp.log(`hello from oh-my-warp! (warp.* API v${warp.version})`);
  warp.log("plugins can also log at warn / error level", "warn");
}
