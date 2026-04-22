# Avark — Bitcoin Wallet on Arkade

A Bitcoin wallet for [Arkade](https://docs.arkadeos.com/) built with Tauri 2 (React + TypeScript frontend, Rust backend).

## Installing

Signed, reproducible builds are published on the [Releases page](https://github.com/Jeezman/avark/releases). Each release includes:

- `avark-<version>-android-arm64-v8a.apk` — modern 64-bit phones (most users).
- `avark-<version>-android-armeabi-v7a.apk` — older / budget 32-bit phones (many Tecno, Infinix, itel, entry-level Samsung).
- `SHA256SUMS` + `SHA256SUMS.asc` — checksums and a GPG signature over them, made by the Avark release key.

See [`docs/VERIFYING.md`](docs/VERIFYING.md) if you're unsure which APK to pick (TL;DR: `arm64-v8a` unless your phone refuses it).

iOS builds are not yet published — track [#iOS-release](https://github.com/Jeezman/avark/issues) if you want it. For now, iOS users can build locally with `pnpm tauri ios build`.

**Before you install, verify.** This is a Bitcoin wallet — users who can't verify shouldn't be trusting it with their sats. See [`docs/VERIFYING.md`](docs/VERIFYING.md) for the full process. TL;DR:

```bash
gpg --import docs/release-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

If any check fails, **do not install the binary** — open an issue.

## Prerequisites

- [Node.js](https://nodejs.org/) (v20.19+ or v22.12+)
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/) (1.86+)

## Getting Started

```bash
pnpm install
pnpm tauri dev
```

## Building

### Desktop

```bash
# Dev mode (hot reload)
pnpm tauri dev

# Production build
pnpm tauri build
```

### Android

#### One-time setup (macOS)

1. Install [Android Studio](https://developer.android.com/studio) and add the NDK via SDK Manager (tested with NDK `26.1.10909125`).

2. Install GNU Make 4+ (macOS ships Make 3.81 which can't build vendored OpenSSL):

   ```bash
   brew install make
   ```

3. Add Android SDK paths to your shell profile (`~/.zshrc` or `~/.bashrc`):

   ```bash
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
   export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"
   ```

4. Add the Android Rust targets:

   ```bash
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

5. Initialize the Tauri Android project (only needed once):

   ```bash
   pnpm tauri android init
   ```

The project includes NDK toolchain shims (`src-tauri/.ndk-shims/`) and Cargo config (`src-tauri/.cargo/config.toml`) that handle cross-compilation automatically — no manual NDK symlinks or env vars needed beyond the above.

#### Build commands

```bash
# Dev mode (deploys to connected device/emulator)
pnpm tauri android dev -- --features vendored-openssl

# Production build (APK + AAB for all architectures)
pnpm tauri android build -- --features vendored-openssl
```

The `vendored-openssl` feature compiles OpenSSL from source for Android targets. Build output:

- **APK**: `src-tauri/gen/android/app/build/outputs/apk/universal/release/`
- **AAB**: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/`

### iOS

```bash
pnpm tauri ios dev
pnpm tauri ios build
```

`tauri.conf.json` pins `bundle.iOS.developmentTeam` to the maintainer's Apple Team ID. If you're building iOS under a different Apple Developer account, override it locally — either edit that field to your own Team ID (don't commit), or set `DEVELOPMENT_TEAM` via an `.xcconfig` / Xcode's Signing & Capabilities tab before building.

## Other Commands

```bash
# Frontend-only dev server (no Tauri, port 1420)
pnpm dev

# Type-check frontend
tsc

# Build frontend only
pnpm build

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Architecture

- **Frontend** (`src/`): React 19 + TypeScript, bundled with Vite 7
- **Backend** (`src-tauri/`): Rust (Tauri 2), using [Arkade rust-sdk](https://github.com/arkade-os/rust-sdk) for Ark protocol operations
- **IPC**: Frontend calls Rust commands via `invoke()` from `@tauri-apps/api/core`

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for the full text.
