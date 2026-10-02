import { UciEngine, type EngineTransport } from "./uci.ts";

export type EngineFlavor = "lite" | "full";

const ENGINE_DIR = `${import.meta.env.BASE_URL}engine/`;
const ENGINE_FILES: Record<EngineFlavor, string> = {
  lite: "stockfish-19-lite-single.js",
  full: "stockfish-19-single.js",
};

function workerTransport(url: string): EngineTransport {
  const worker = new Worker(url);
  return {
    send: (cmd) => worker.postMessage(cmd),
    onLine: (listener) => {
      worker.addEventListener("message", (e: MessageEvent) => {
        if (typeof e.data === "string") listener(e.data);
      });
    },
    terminate: () => worker.terminate(),
  };
}

export async function fullEngineAvailable(): Promise<boolean> {
  try {
    const res = await fetch(ENGINE_DIR + ENGINE_FILES.full, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts Stockfish 19 in a Web Worker. Single-threaded builds are used on
 * purpose: they need no cross-origin isolation headers, so the app works on any
 * static host, and in testing the multi-threaded WASM build was not faster.
 */
export async function createBrowserEngine(flavor: EngineFlavor): Promise<UciEngine> {
  const engine = new UciEngine(workerTransport(ENGINE_DIR + ENGINE_FILES[flavor]));
  await engine.init({ hashMb: 64 });
  return engine;
}
