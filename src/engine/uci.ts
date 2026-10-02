// Minimal UCI client for Stockfish. Transport-agnostic so the same code drives
// a browser Web Worker and a Node child process (used by the tests and CLI).

export interface EngineTransport {
  send(command: string): void;
  onLine(listener: (line: string) => void): void;
  terminate(): void;
}

/** Engine score from the side-to-move's point of view, exactly as UCI reports it. */
export type UciScore = { cp: number } | { mate: number };

export interface UciLine {
  multipv: number;
  depth: number;
  score: UciScore;
  pv: string[];
}

export interface UciSearchResult {
  fen: string;
  depth: number;
  lines: UciLine[];
  bestmove: string | null;
}

export interface SearchLimits {
  depth?: number;
  movetime?: number;
  multipv?: number;
}

export interface EngineInfo {
  name: string;
}

export function parseInfoLine(line: string): UciLine | null {
  if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
  // Bound scores come from aspiration-window fail highs/lows; they are not exact.
  if (line.includes(" lowerbound") || line.includes(" upperbound")) return null;
  const tokens = line.split(/\s+/);
  let depth = -1;
  let multipv = 1;
  let score: UciScore | null = null;
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "depth") depth = Number(tokens[++i]);
    else if (t === "multipv") multipv = Number(tokens[++i]);
    else if (t === "score") {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      score = kind === "mate" ? { mate: value } : { cp: value };
    } else if (t === "pv") {
      pv = tokens.slice(i + 1);
      break;
    }
  }
  if (depth < 0 || !score || pv.length === 0) return null;
  return { multipv, depth, score, pv };
}

export class UciEngine {
  private listeners = new Set<(line: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private currentMultiPv = 1;
  info: EngineInfo = { name: "Stockfish" };

  private transport: EngineTransport;

  constructor(transport: EngineTransport) {
    this.transport = transport;
    transport.onLine((raw) => {
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) for (const l of [...this.listeners]) l(trimmed);
      }
    });
  }

  private waitFor(predicate: (line: string) => boolean, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve) => {
      const listener = (line: string) => {
        onLine?.(line);
        if (predicate(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }

  async init(options: { hashMb?: number } = {}): Promise<EngineInfo> {
    const uciok = this.waitFor(
      (l) => l === "uciok",
      (l) => {
        if (l.startsWith("id name ")) this.info.name = l.slice("id name ".length);
      },
    );
    this.transport.send("uci");
    await uciok;
    this.transport.send(`setoption name Hash value ${options.hashMb ?? 64}`);
    await this.ready();
    return this.info;
  }

  private ready(): Promise<string> {
    const p = this.waitFor((l) => l === "readyok");
    this.transport.send("isready");
    return p;
  }

  newGame(): Promise<void> {
    return this.enqueue(async () => {
      this.transport.send("ucinewgame");
      await this.ready();
    });
  }

  /** Searches one position. Calls are serialized; the engine handles one search at a time. */
  analyze(fen: string, limits: SearchLimits, onProgress?: (lines: UciLine[]) => void): Promise<UciSearchResult> {
    return this.enqueue(async () => {
      const multipv = limits.multipv ?? 1;
      if (multipv !== this.currentMultiPv) {
        this.transport.send(`setoption name MultiPV value ${multipv}`);
        this.currentMultiPv = multipv;
        await this.ready();
      }
      const latest = new Map<number, UciLine>();
      const done = this.waitFor(
        (l) => l.startsWith("bestmove"),
        (l) => {
          const info = parseInfoLine(l);
          if (!info) return;
          const prev = latest.get(info.multipv);
          if (!prev || info.depth >= prev.depth) latest.set(info.multipv, info);
          if (onProgress && info.multipv === 1) onProgress(sortedLines(latest));
        },
      );
      this.transport.send(`position fen ${fen}`);
      const go = limits.depth ? `go depth ${limits.depth}` : `go movetime ${limits.movetime ?? 1000}`;
      this.transport.send(go);
      const bestLine = await done;
      const best = bestLine.split(/\s+/)[1];
      const lines = sortedLines(latest);
      return {
        fen,
        depth: lines[0]?.depth ?? 0,
        lines,
        bestmove: best && best !== "(none)" ? best : null,
      };
    });
  }

  /** Interrupts the running search (it still resolves, with what it has so far). */
  stop(): void {
    this.transport.send("stop");
  }

  quit(): void {
    this.transport.send("quit");
    this.transport.terminate();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sortedLines(map: Map<number, UciLine>): UciLine[] {
  return [...map.values()].sort((a, b) => a.multipv - b.multipv);
}
