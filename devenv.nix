# oh-my-warp build environment.
#
# Warp's upstream flake.nix is Linux-only (its devShell and buildInputs target
# x86_64/aarch64-linux with Wayland/X11/Vulkan/ALSA libs). This devenv assembles
# a cross-platform shell — works on aarch64-darwin — with the pinned Rust
# toolchain (1.92.0 from rust-toolchain.toml) plus the native build dependencies
# needed to `cargo check`/build the `warp` app crate.
#
# Usage:
#   devenv shell                       # enter the shell
#   devenv shell -- cargo check -p warp
{
  pkgs,
  lib,
  inputs,
  ...
}:
let
  # Re-import nixpkgs with the rust-overlay so we can resolve the exact toolchain
  # named in rust-toolchain.toml (matches how flake.nix builds the toolchain).
  rustPkgs = import inputs.nixpkgs {
    inherit (pkgs.stdenv.hostPlatform) system;
    overlays = [ inputs.rust-overlay.overlays.default ];
  };
  rustToolchain = rustPkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
in
{
  # Cross-platform subset of flake.nix's devShell nativeBuildInputs. The
  # Linux-only GUI/runtime libs and bundling tools (patchelf, makeWrapper,
  # wayland, x11, vulkan, alsa, udev, libGL) are omitted; on macOS the GUI links
  # against system frameworks and `cargo check` does not link the final binary.
  packages =
    with pkgs;
    [
      rustToolchain
      protobuf
      cmake
      pkg-config
      openssl
      libgit2
      python3
      jq
      brotli
      cargo-about
      cargo-nextest
    ]
    ++ lib.optionals stdenv.isDarwin [
      # `cc`/clang come from the darwin stdenv; libiconv is commonly needed when
      # linking macOS Rust crates.
      libiconv
    ];

  env = {
    PROTOC = "${pkgs.protobuf}/bin/protoc";
    PROTOC_INCLUDE = "${pkgs.protobuf}/include";
    LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
    # Use the nix-provided OpenSSL via pkg-config instead of compiling a vendored
    # copy.
    OPENSSL_NO_VENDOR = "1";
  };

  enterShell = ''
    echo "oh-my-warp build env: $(rustc --version 2>/dev/null) | $(protoc --version 2>/dev/null)"
  '';
}
