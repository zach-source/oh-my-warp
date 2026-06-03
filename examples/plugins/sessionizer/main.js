// oh-my-warp — Sessionizer plugin.
//
// A tmux-sessionizer-style project switcher. Run it (palette "Sessionizer: Switch
// Project" or the leader chord ctrl-b f) to fuzzy-pick a git repo under your dev
// roots and switch to it. If a tab rooted at that repo is already open it is
// focused; otherwise a new tab with a terminal there is opened (switch-or-create,
// handled app-side by the `warp:openProject:<path>` palette sentinel → patch 0039).
//
// Discovery re-runs on every invocation, so repos created after Warp launched show
// up without a restart. It deliberately does NOT register a command per project:
// doing so from inside this command's callback would re-enter the plugin host and
// crash it — instead each palette item carries the `warp:openProject:` sentinel,
// which the app resolves directly.
//
// Roots: by default it scans common dev dirs under $HOME. To override, create
// ~/.warp/oh-my-warp/sessionizer-roots.txt with one directory per line (a leading
// ~/ is expanded; blank lines and #-comments are ignored).
//
// Capabilities (manifest `permissions`): commands, process, ui, fs:read.

export function activate(warp) {
  const FIND = "/usr/bin/find"; // BSD find on macOS; lives in the GUI PATH (/usr/bin).
  const MAX_PROJECTS = 500; // guardrail so a huge tree can't flood the palette.

  // $HOME, derived from the plugin dir (~/.warp/plugins/sessionizer).
  const home = (warp.plugin.dir || "").split("/.warp/")[0] || "";
  const ROOTS_FILE = home
    ? `${home}/.warp/oh-my-warp/sessionizer-roots.txt`
    : null;
  const DEFAULT_ROOT_NAMES = [
    "repos",
    "src",
    "projects",
    "work",
    "code",
    "dev",
    "Developer",
    "go/src",
  ];

  function expandHome(p) {
    if (p === "~") return home;
    if (p.startsWith("~/")) return home + p.slice(1);
    return p;
  }

  // The roots to scan: the config file (if present and non-empty) fully overrides
  // the built-in defaults.
  function roots() {
    if (ROOTS_FILE) {
      try {
        const lines = warp.fs
          .readFile(ROOTS_FILE)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"))
          .map(expandHome);
        if (lines.length) return lines;
      } catch (_) {
        /* no config file -> fall through to defaults */
      }
    }
    return home ? DEFAULT_ROOT_NAMES.map((r) => `${home}/${r}`) : [];
  }

  // Discover git repos: directories containing a `.git` exactly one level under
  // each root (so `<root>/<repo>/.git`).
  function discoverProjects() {
    const seen = new Set();
    const projects = [];
    for (const root of roots()) {
      let stdout = "";
      try {
        const res = warp.process.exec(FIND, [
          root,
          "-mindepth",
          "2",
          "-maxdepth",
          "2",
          "-name",
          ".git",
        ]);
        if (res.code !== 0) continue; // root probably doesn't exist
        stdout = res.stdout || "";
      } catch (_) {
        continue; // find missing / not permitted
      }
      for (const line of stdout.split("\n")) {
        const git = line.trim();
        if (!git) continue;
        const path = git.replace(/\/\.git$/, ""); // parent of .git = the repo
        if (!path || seen.has(path)) continue;
        seen.add(path);
        projects.push({ path, name: path.split("/").pop() || path });
      }
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects.slice(0, MAX_PROJECTS);
  }

  warp.commands.register(
    "sessionizer.switch",
    "Sessionizer: Switch Project",
    () => {
      const projects = discoverProjects();
      if (projects.length === 0) {
        warp.ui.toast(
          `Sessionizer: no git repos found under ${roots().join(", ") || "(no roots)"}`,
          "warn",
        );
        return;
      }
      // Each item opens its project via the app-side sentinel (switch-or-create).
      // `description` shows the full path under the bold project name; the picker
      // fuzzy-matches against both, so typing a path fragment works too.
      warp.ui.showPalette(
        "Switch to project",
        projects.map((p) => ({
          icon: "📁",
          label: p.name,
          description: p.path,
          command: `warp:openProject:${p.path}`,
        })),
      );
    },
  );

  // tmux-sessionizer muscle memory: leader (ctrl-b) then "f" (find project).
  warp.keymap.bind("sessionizer.switch", "ctrl-b f");

  warp.log("Sessionizer ready (ctrl-b f to switch projects)");
}
