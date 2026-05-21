# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **fork of `warpdotdev/warp`** maintained as **"oh-my-warp"** — an oh-my-zsh-style overlay that layers customizations on top of *pristine* upstream Warp while staying permanently mergeable with it. The customizations are kept as a **quilt-style patch series** (`patches/`) applied on demand by the **`./omw`** tool.

- `OMW.md` — the user-facing overview of the overlay.
- `WARP.md` — **upstream's** agent guide: build/test/lint commands, coding style, and the broader architecture. Follow it for anything touching upstream code (notably: `ctx` is the last param; no `_`-prefixed unused params; inline format args; **exhaustive `match` — no `_` wildcards**).

## THE GOLDEN RULE: never edit upstream files in place on `oh-my-warp`

The fork uses a **two-branch mirror model**:
- **`master`** is a **pristine mirror of `upstream/master`** — never edited, so it fast-forwards to new Warp releases trivially (GitHub "Sync fork" / `git pull upstream master` are always clean).
- **`oh-my-warp`** is the **working branch** (and the fork's default branch on `origin`): `master`'s tree **+** an additive overlay (`omw`, `OMW.md`, `CLAUDE.md`, `devenv.nix`/`devenv.yaml`, `patches/`, `examples/`).

Every change to an *upstream* file lives as a patch in `patches/`, never as an in-place edit on `oh-my-warp`. This is what keeps upstream merges conflict-free. **`git diff $(git merge-base oh-my-warp master) oh-my-warp -- app/ crates/` must stay empty** (the guarantee is about *code*: the overlay never modifies upstream files outside the patch series).

The one deliberate exception is **`README.md`** on `oh-my-warp`: it carries an oh-my-warp banner prepended (upstream's README preserved verbatim below the divider) so the fork's GitHub page describes itself. It's a top insertion, so syncs still merge upstream's README edits cleanly. Don't "restore" it to pristine. (`master`, being a pure mirror, keeps upstream's README verbatim — that's correct, not a regression.)

## The oh-my-warp workflow (how to extend Warp)

Driven by `./omw` (`status` · `list` · `apply` · `save` · `sync`):

1. `./omw apply` — rebuilds the throwaway `omw/applied` branch = `oh-my-warp` + every patch (via `git am`), and leaves you on it. **Requires a clean working tree** — commit/stash any overlay changes on `oh-my-warp` first.
2. Edit upstream files on `omw/applied`. **One logical change per commit** — the commit subject becomes the patch filename.
3. `./omw save` — regenerates `patches/` + `patches/series` from those commits, commits them on `oh-my-warp`, and returns the tree to pristine.
4. `git push` — publish to `origin` (`zach-source/oh-my-warp`); `oh-my-warp` is the default branch. `upstream` is fetch-only.
5. `./omw sync` — `git fetch upstream` + fast-forward the `master` mirror + merge it into `oh-my-warp` (clean, additive) + re-apply patches.

**Where new code goes:**
- A change to an existing upstream file → **must be a patch** (edit on `omw/applied`, then `omw save`).
- A *new* file a patch depends on (e.g. `app/src/util/leader.rs`) → part of that patch (created on `omw/applied`).
- New overlay tooling/docs Warp doesn't ship (e.g. `omw`, `devenv.nix`, `CLAUDE.md`, anything under `examples/`) → committed straight to `oh-my-warp`, **not** in the patch series.

## Building & running on macOS

Upstream `flake.nix` is **Linux-only**, so use **devenv** (`devenv.nix` provides the pinned Rust 1.92.0 + native build deps). Prefix toolchain commands with `devenv shell -- …`.

- **Always `./omw apply` before building** — otherwise you build `oh-my-warp` (or `master`) *without the patches applied* (the #1 mistake; the feature silently isn't there).
- Type-check: `devenv shell -- cargo check -p warp --lib` (the app crate is `warp`, at `app/`). The wrapper's exit code is **not** cargo's — append `echo "CARGO_EXIT=$?"` to read the real result.
- Full build + bundle (macOS): `devenv shell -- bash -lc 'export WARP_SKIP_COMMON_SKILLS_INSTALL=1; ./script/run --dont-open'` → `target/debug/bundle/osx/oh-my-warp.app` (rebranded by patch 0008; upstream's name is `WarpOss.app`).
- **Launch the built app from Finder/launchd** (the `~/Desktop/oh-my-warp Dev` launcher, which must point at `…/bundle/osx/oh-my-warp.app`), **not** from the devenv/Claude shell — see gotcha #5.
- Tests & lint: see `WARP.md` (`cargo nextest run …`, `cargo test -p <crate>`, `./script/presubmit`). A `PostToolUse` `smart-lint` hook **blocks edits with rustfmt issues** — run `rustfmt --edition 2021 <file>` (or `cargo fmt`) after editing Rust.

## Gotchas we hit (and the fixes)

1. **Feature "did nothing" after a build** → it was built from `oh-my-warp` (or `master`) without the patches applied. Fix: `./omw apply` first, build from `omw/applied`.
2. **`error: tool 'metal' not found`** → Xcode's Metal Toolchain isn't installed (separate component on Xcode 26+): `xcodebuild -downloadComponent MetalToolchain`. If that errors loading a plugin, repair first with `xcodebuild -runFirstLaunch`.
3. **`ld: library 'iconv' not found` building `aws-lc-sys`** → caused by setting `DEVELOPER_DIR=Xcode` *globally* (breaks the nix linker). Keep the build on the nix toolchain and point `xcrun` at Xcode for the **metal step only** via `WARP_METAL_DEVELOPER_DIR` (patch 0005 + `devenv.nix` env).
4. **`cargo check` fails without the Metal Toolchain** (`shaders.metallib` is `include_bytes!`'d) → temporarily make `crates/warpui/build.rs::compile_metal_shaders` write an empty metallib behind `OMW_SKIP_METAL` and `return`, then revert.
5. **Leader (`ctrl-b`) chord did nothing in the terminal** → `EditorView` bound `ctrl-b` to `editor_view:left`, and the matcher fires an **exact single-key match before a longer sequence**, shadowing the prefix. Fix (patch 0004): unbind `ctrl-b` there. General rule: *a leader/prefix key cannot coexist with any exact single-key binding for that key in the active context.*
6. **Dev build's zsh: "stale nix paths" / `argument list too long`** → the app was launched carrying devenv build vars (`NIX_LDFLAGS`, `PKG_CONFIG_PATH`) and injected them into child shells. Fix: launch via Finder/launchd (clean GUI env), not from the devenv/Claude shell. `open` propagates the caller's environment.

## Keymap / leader architecture (where the patches live)

The leader feature is the worked example; this is the part of upstream worth understanding before editing it.

- **Keymap engine**: `crates/warpui_core/src/keymap.rs` + `keymap/matcher.rs`. `Trigger::Keystrokes(Vec<Keystroke>)` is a **sequence** (e.g. `"ctrl-b ,"`). `Matcher::push_keystroke` tracks `pending` per responder-chain entity and returns `None` / `Pending` / `Action`; **an exact match returns immediately, beating any longer prefix** in the same scan.
- **Input pipeline**: `crates/warpui_core/src/core/app.rs` → `handle_window_event` → `dispatch_keystroke`. Only `MatchResult::None` forwards the key to the PTY, so matched/pending keys are intercepted from the shell (this is why `ctrl-b` can be a prefix; also why it must be allowlisted — next point).
- **PTY compliance**: `app/src/util/bindings.rs::is_binding_pty_compliant` panics in debug on `ctrl-<letter>` bindings unless the keystroke is in `PTY_NON_COMPLIANT_KEYSTROKES` (`ctrl-b` is allowlisted there).
- **Binding registration is distributed**: each view registers in its own `*::init` (e.g. `app/src/workspace/mod.rs::init`) with a context predicate `id!("ViewName")`. `FixedBinding` = not user-editable; `EditableBinding` = named, overridable in `~/.../keybindings.yaml` (which supports multi-key sequences) and shown in Settings → Keyboard Shortcuts.
- **Two action systems**: typed actions (e.g. `WorkspaceAction`, dispatched to `TypedActionView`) vs `CustomAction` (menu items via `CustomTag`). Leader chords bind to typed `WorkspaceAction`s (`RenameActiveTab`, `AddDefaultTab`, …).
- **Leader feature files** (patches 0001–0004): `app/src/util/leader.rs` (the chord table + registration, called from `workspace::init`), `BindingGroup::Leader` in `app/src/util/bindings.rs`, the engaged-indicator plumbing (matcher pending → `AppContext::keymap_pending_keystrokes` + auto-cancel timeout in `core/app.rs` → tab-bar pill in `app/src/workspace/view.rs`).
- **Adding an enum variant** (e.g. `BindingGroup::Leader`) breaks upstream's exhaustive `match`es — fix every arm (we had to in `app/src/search/action/search_item.rs`).

## Layout

- `app/` — the `warp` crate (terminal, ai, workspace, settings, util, editor, …); bins in `app/src/bin/` (`warp-oss` = `oss.rs`, the `default-run`).
- `crates/` — libraries: `warpui_core`/`warpui` (UI framework + keymap), `warp_core`, `editor`, `persistence` (Diesel/SQLite), `integration` (test harness), …
- `patches/` — the overlay's patch series (`series` + `NNNN-*.patch`).
- `omw`, `OMW.md`, `devenv.nix`, `devenv.yaml`, `examples/` — overlay tooling/docs (on `oh-my-warp`, not patched).
