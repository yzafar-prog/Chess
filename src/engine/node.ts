// Node transport: runs the Stockfish WASM build as a child process. Used by
// the integration tests and the command-line analyzer, not by the web app.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { UciEngine, type EngineTransport } from "./uci.ts";

export function nodeEnginePath(build = "stockfish-19-lite-single"): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("stockfish/package.json")), "bin", `${build}.js`);
}

export async function createNodeEngine(build?: string): Promise<UciEngine> {
  const child = spawn(process.execPath, [nodeEnginePath(build)], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout });
  const transport: EngineTransport = {
    send: (cmd) => child.stdin.write(cmd + "\n"),
    onLine: (listener) => rl.on("line", listener),
    terminate: () => child.kill(),
  };
  const engine = new UciEngine(transport);
  await engine.init({ hashMb: 64 });
  return engine;
}
