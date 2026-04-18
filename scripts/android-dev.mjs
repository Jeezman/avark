// Run `pnpm tauri android dev` with a logcat-driven launch hijacker so the
// `.debug` variant is what actually opens on the device.
//
// Why this exists: `applicationIdSuffix = ".debug"` in the debug buildType
// makes Gradle build + install the APK under `com.jeezman.avark.debug`, which
// lets it coexist with the release `com.jeezman.avark` on the launcher.
// Tauri's CLI, however, launches the base identifier from tauri.conf.json
// after each install — so it keeps opening the prod app. This script watches
// logcat for Tauri's `am start com.jeezman.avark/.MainActivity` attempts and
// redirects them to `com.jeezman.avark.debug/com.jeezman.avark.MainActivity`.
//
// Usage: `pnpm dev:android`

import { spawn } from "node:child_process";

const BASE = "com.jeezman.avark";
const DEBUG = `${BASE}.debug`;
const DEBUG_ACTIVITY = `${DEBUG}/${BASE}.MainActivity`;

// Match tauri's base-package launch line in logcat, e.g.
//   I ActivityTaskManager: START u0 {... cmp=com.jeezman.avark/.MainActivity}
//     with LAUNCH_SINGLE_TASK from uid 2000 (BAL_ALLOW_PERMISSION) ...
//
// The `from uid 2000` clause is what keeps us from stomping on real user
// taps — uid 2000 is the adb shell (Tauri's CLI), the home launcher has a
// different uid, so manual prod-icon taps are left alone.
const BASE_LAUNCH_PATTERN = new RegExp(
  `cmp=${BASE.replace(/\./g, "\\.")}/\\.MainActivity\\b.*from uid 2000`,
);

function log(msg) {
  console.log(`[android-dev] ${msg}`);
}

// Start tauri android dev in a child process, streaming its output.
const tauri = spawn(
  "pnpm",
  ["tauri", "android", "dev", "--", "--features", "vendored-openssl"],
  { stdio: "inherit" },
);

// Run adb logcat in parallel so we can observe launch attempts. Filter to
// the ActivityTaskManager tag so we don't burn CPU on the full stream.
const logcat = spawn(
  "adb",
  ["logcat", "-s", "ActivityTaskManager:I"],
  { stdio: ["ignore", "pipe", "inherit"] },
);

let redirectInFlight = false;

logcat.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  if (!BASE_LAUNCH_PATTERN.test(text)) return;
  if (redirectInFlight) return;
  redirectInFlight = true;

  log(`→ hijacking launch → ${DEBUG_ACTIVITY}`);
  const redirect = spawn(
    "sh",
    [
      "-c",
      `adb shell am force-stop ${BASE} && adb shell am start -n ${DEBUG_ACTIVITY}`,
    ],
    { stdio: "inherit" },
  );
  redirect.on("exit", () => {
    // Short cooldown so we don't thrash if Android fires multiple START lines
    // for the same launch (it usually does).
    setTimeout(() => {
      redirectInFlight = false;
    }, 1500);
  });
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  try {
    logcat.kill();
  } catch {}
  try {
    tauri.kill(signal);
  } catch {}
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

tauri.on("exit", (code) => {
  try {
    logcat.kill();
  } catch {}
  process.exit(code ?? 0);
});

logcat.on("exit", () => {
  // If logcat dies (device disconnect), keep tauri running — user may be
  // plugging the device back in. Nothing else to do here.
});
