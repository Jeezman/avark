# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Avark (Arkvark) is a Bitcoin wallet for [Arkade](https://docs.arkadeos.com/) built as a Tauri 2 desktop app with a React + TypeScript frontend and a Rust backend.

## Architecture

- **Frontend** (`src/`): React 19 + TypeScript, bundled with Vite 7. Entry point is `src/main.tsx` → `src/App.tsx`.
- **Backend** (`src-tauri/`): Rust (Tauri 2). Entry point is `src-tauri/src/main.rs` which calls `avark_lib::run()` defined in `src-tauri/src/lib.rs`. The Rust crate is named `avark_lib`.
- **IPC**: Frontend calls Rust commands via `invoke()` from `@tauri-apps/api/core`. Rust commands are registered in `lib.rs` via `tauri::generate_handler![]`.
- **Config**: `src-tauri/tauri.conf.json` defines the app window, bundle settings, and build commands. App identifier: `com.jeezman.avark`.

## Commands

```bash
# Install JS dependencies
pnpm install

# Dev mode (launches Tauri app with hot reload)
pnpm tauri dev

# Build production app
pnpm tauri build

# Frontend-only dev server (no Tauri, runs on port 1420)
pnpm dev

# Type-check
tsc

# Build frontend only
pnpm build
```

## Mobile Builds

```bash
# Always build for android and ios and make sure it works
pnpm tauri android dev/build -- --features vendored-openssl
pnpm tauri ios dev/build
```

## Key Details

- Package manager: **pnpm**
- Vite dev server runs on port **1420** (strict port, required by Tauri)
- TypeScript strict mode is enabled with `noUnusedLocals` and `noUnusedParameters`
- Rust edition 2021; dependencies include `serde`, `serde_json`, and `tauri-plugin-opener`

- run cargo fmt for .rs created or updated

## User Stories Reference

See `tasks/*` for PRDs

Mark each user story done when the story is complete

## Testing

Write tests (unit and integration).
Never write tests for what the type system or compiler already handles.
