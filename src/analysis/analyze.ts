import { Chess } from "chess.js";
import type { UciEngine } from "../engine/uci.ts";
import { uciLineToSan } from "./pgn.ts";
import { fromUci, type Color, type Score } from "./score.ts";

export interface EngineLine {
  score: Score;
  uci: string[];
  san: string[];
}

export interface PositionEval {
  fen: string;
  depth: number;
  /** MultiPV lines, best first. Empty for terminal positions. */
  lines: EngineLine[];
  /** Score of the position under best play (White POV). */
  score: Score;
  terminal?: "checkmate" | "stalemate" | "draw";
}

export interface AnalysisSettings {
  depth: number;
  multipv: number;
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const PV_SAN_LIMIT = 14;

export function terminalEval(fen: string): PositionEval | null {
  const chess = new Chess(fen);
  const toMove = chess.turn() as Color;
  if (chess.isCheckmate()) {
    return { fen, depth: 0, lines: [], score: { mate: 0, winner: toMove === "w" ? "b" : "w" }, terminal: "checkmate" };
  }
  if (chess.isStalemate()) return { fen, depth: 0, lines: [], score: { cp: 0 }, terminal: "stalemate" };
  if (chess.isInsufficientMaterial()) return { fen, depth: 0, lines: [], score: { cp: 0 }, terminal: "draw" };
  return null;
}

export async function evaluatePosition(
  engine: UciEngine,
  fen: string,
  settings: AnalysisSettings,
): Promise<PositionEval> {
  const terminal = terminalEval(fen);
  if (terminal) return terminal;
  const toMove = fen.split(" ")[1] as Color;
  const result = await engine.analyze(fen, { depth: settings.depth, multipv: settings.multipv });
  const lines: EngineLine[] = result.lines.map((l) => ({
    score: fromUci(l.score, toMove),
    uci: l.pv,
    san: uciLineToSan(fen, l.pv.slice(0, PV_SAN_LIMIT)),
  }));
  if (lines.length === 0) throw new Error(`Engine returned no evaluation for ${fen}`);
  return { fen, depth: result.depth, lines, score: lines[0].score };
}

/** Evaluates every position of the game (start position, after each move). */
export async function analyzePositions(
  engine: UciEngine,
  fens: string[],
  settings: AnalysisSettings,
  options: AnalyzeOptions = {},
): Promise<PositionEval[]> {
  await engine.newGame();
  const out: PositionEval[] = [];
  const onAbort = () => engine.stop();
  options.signal?.addEventListener("abort", onAbort);
  try {
    for (let i = 0; i < fens.length; i++) {
      if (options.signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
      out.push(await evaluatePosition(engine, fens[i], settings));
      options.onProgress?.(i + 1, fens.length);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (options.signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
  return out;
}
