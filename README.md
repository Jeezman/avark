# Avark — Bitcoin Wallet on Arkade

A Bitcoin wallet for [Arkade](https://docs.arkadeos.com/) built with Tauri 2 (React + TypeScript frontend, Rust backend).

## Prerequisites

- [Node.js](https://nodejs.org/) (v20.19+ or v22.12+)
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/) (1.86+)
- [Tauri CLI](https://tauri.app/start/): `cargo install tauri-cli`

### Android Development

- [Android Studio](https://developer.android.com/studio) with NDK installed
- GNU Make 4+ (macOS ships with Make 3.81 which can't build vendored OpenSSL)
- NDK toolchain shims for OpenSSL cross-compilation

#### Android Setup (macOS)

1. **Install GNU Make 4+**:

   ```bash
   brew install make
   ```

2. **Add to your shell profile** (`~/.zshrc` or `~/.bashrc`):

   ```bash
   export ANDROID_HOME=$HOME/Library/Android/sdk
   export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
   export PATH=$PATH:$ANDROID_HOME/emulator
   export PATH=$PATH:$ANDROID_HOME/platform-tools
   export PATH=$PATH:$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin
   export MAKE="/opt/homebrew/opt/make/libexec/gnubin/make"
   ```

3. **Create the `aarch64-linux-android-ranlib` symlink** (required by vendored OpenSSL):

   ```bash
   ln -sf $NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-ranlib \
          $NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android-ranlib
   ```

4. **Reload your shell**:

   ```bash
   source ~/.zshrc
   ```

## Commands

```bash
# Install JS dependencies
pnpm install

# Desktop dev mode (hot reload)
pnpm tauri dev

# Desktop production build
pnpm tauri build

# Android dev mode (hot reload, deploys to connected device)
pnpm tauri android dev -- --features vendored-openssl

# Android production build
pnpm tauri android build -- --features vendored-openssl

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
