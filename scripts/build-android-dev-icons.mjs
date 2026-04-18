// Generates a "DEV"-badged Android icon set for the debug build type.
//
// Inputs:
//   icons/Icon-1024.png            — the same 1024×1024 source used by
//                                    `pnpm tauri icon` for the release icons.
//
// Outputs (overwritten every run):
//   src-tauri/gen/android/app/src/debug/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/
//     ic_launcher.png               (matches main/ dimensions)
//     ic_launcher_round.png         (matches main/ dimensions)
//     ic_launcher_foreground.png    (matches main/ dimensions)
//
// Gradle merges src/debug/res over src/main/res when building the `debug`
// variant, so these override the release icons automatically. Combined with
// the `applicationIdSuffix = ".debug"` in app/build.gradle.kts and the red
// `ic_launcher_background` override, the dev APK installs as a visually
// distinct app next to the release build.
//
// Run:  pnpm android-dev-icons
// Re-run whenever icons/Icon-1024.png changes.

import sharp from "sharp";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SOURCE = resolve(ROOT, "icons/Icon-1024.png");
const MAIN_RES = resolve(
  ROOT,
  "src-tauri/gen/android/app/src/main/res",
);
const DEBUG_RES = resolve(
  ROOT,
  "src-tauri/gen/android/app/src/debug/res",
);

const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
const ICON_FILES = [
  "ic_launcher.png",
  "ic_launcher_round.png",
  "ic_launcher_foreground.png",
];

// Diagonal red corner ribbon with "DEV" — sized in proportional units so it
// composites onto any target resolution. We re-render it per target size so
// text stays crisp.
function ribbonSvg(sizePx) {
  // Ribbon covers ~40% of the edge, anchored top-right, rotated 45°.
  // Text tracking widens as the icon grows so it looks proportional.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${sizePx}" height="${sizePx}">
  <g transform="translate(78 22) rotate(45) translate(-50 -10)">
    <rect x="0" y="0" width="100" height="20" fill="#dc2626"/>
    <rect x="0" y="0" width="100" height="2" fill="#7f1d1d" opacity="0.6"/>
    <rect x="0" y="18" width="100" height="2" fill="#450a0a" opacity="0.6"/>
    <text x="50" y="14.5"
          font-family="Helvetica, Arial, sans-serif"
          font-size="11"
          font-weight="900"
          fill="#ffffff"
          text-anchor="middle"
          letter-spacing="1.8">DEV</text>
  </g>
</svg>`;
}

async function targetSize(density, filename) {
  const mainPath = resolve(MAIN_RES, `mipmap-${density}`, filename);
  try {
    const meta = await sharp(mainPath).metadata();
    return { width: meta.width, height: meta.height };
  } catch {
    // main/ doesn't have this file — skip (shouldn't happen after `tauri icon`)
    return null;
  }
}

async function generate(srcPng, density, filename) {
  const size = await targetSize(density, filename);
  if (!size) return false;

  const ribbon = Buffer.from(ribbonSvg(size.width));
  const outPath = resolve(DEBUG_RES, `mipmap-${density}`, filename);
  await mkdir(dirname(outPath), { recursive: true });

  await sharp(srcPng)
    .resize(size.width, size.height, { fit: "cover" })
    .composite([{ input: ribbon, top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`  ${density}/${filename.padEnd(28)} ${size.width}×${size.height}`);
  return true;
}

async function main() {
  try {
    await stat(SOURCE);
  } catch {
    console.error(`✗ Source icon not found: ${SOURCE}`);
    process.exit(1);
  }
  try {
    await stat(MAIN_RES);
  } catch {
    console.error(
      `✗ Main Android res dir not found: ${MAIN_RES}\n  Run \`pnpm tauri icon icons/Icon-1024.png\` first to seed the release icons.`,
    );
    process.exit(1);
  }

  const srcPng = await readFile(SOURCE);
  console.log(`→ Generating DEV-badged icons from ${SOURCE}`);

  let written = 0;
  for (const density of DENSITIES) {
    for (const filename of ICON_FILES) {
      if (await generate(srcPng, density, filename)) written++;
    }
  }

  // The adaptive icon XML in debug/ would be identical to main/, so we skip
  // duplicating it. `mipmap-anydpi-v26/ic_launcher.xml` from main/ keeps
  // working — it references `@mipmap/ic_launcher_foreground` (debug override)
  // and `@color/ic_launcher_background` (debug override in values/).

  await writeFile(
    resolve(DEBUG_RES, "README.md"),
    "# debug/res — auto-generated\n\n" +
      "Icon overrides for the `.debug` applicationId. Regenerate with\n" +
      "`pnpm android-dev-icons`. See scripts/build-android-dev-icons.mjs.\n",
  );

  console.log(`✓ Wrote ${written} icon PNGs to ${DEBUG_RES}`);
}

await main();
