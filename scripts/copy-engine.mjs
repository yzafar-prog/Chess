// Copies the Stockfish WASM builds out of node_modules into public/engine so
// the browser can load them as Web Workers. Runs automatically on `npm install`.
//
// By default only the "lite" build (~1.7 MB) is copied. Set
// FULL_ENGINE=1 to also copy the full-strength single-threaded build (~99 MB).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "stockfish", "bin");
const dest = join(root, "public", "engine");

if (!existsSync(src)) {
  console.warn("[copy-engine] stockfish package not installed yet; skipping");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });

const builds = ["stockfish-19-lite-single"];
if (process.env.FULL_ENGINE === "1") builds.push("stockfish-19-single");

for (const name of builds) {
  for (const ext of [".js", ".wasm"]) {
    copyFileSync(join(src, name + ext), join(dest, name + ext));
  }
}
console.log(`[copy-engine] copied ${builds.join(", ")} to public/engine`);
