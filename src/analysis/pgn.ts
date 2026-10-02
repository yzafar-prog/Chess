import { Chess, DEFAULT_POSITION } from "chess.js";
import type { Color } from "./score.ts";

export interface Ply {
  index: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  fenBefore: string;
  fenAfter: string;
  legalMoveCount: number;
  /** Remaining clock after the move, from a [%clk h:mm:ss] comment, if present. */
  clockSeconds?: number;
}

export interface ParsedGame {
  headers: Record<string, string>;
  startFen: string;
  plies: Ply[];
  /** Positions 0..n: positions[i] is the position before plies[i]; the last one is the final position. */
  fens: string[];
}

/** Splits a PGN file that may contain several games. */
export function splitPgn(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const chunks = normalized.split(/\n\s*\n(?=\s*\[Event\s)/);
  return chunks.map((c) => c.trim()).filter((c) => /\S/.test(c));
}

function parseClock(comment: string | undefined): number | undefined {
  const m = comment?.match(/\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parseGame(pgn: string): ParsedGame {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (err) {
    throw new Error(`Could not read this PGN: ${(err as Error).message}`);
  }
  const headers = Object.fromEntries(
    Object.entries(chess.getHeaders()).filter(([, v]) => v !== undefined && v !== null),
  ) as Record<string, string>;
  const comments = new Map(chess.getComments().map((c) => [c.fen, c.comment]));
  const history = chess.history({ verbose: true });
  if (history.length === 0) throw new Error("The PGN has no moves to analyze.");

  const startFen = headers.FEN ?? history[0]?.before ?? DEFAULT_POSITION;
  const replay = new Chess(startFen);
  const plies: Ply[] = history.map((m, index) => {
    const legalMoveCount = replay.moves().length;
    replay.move(m.san);
    const fenBefore = m.before;
    return {
      index,
      moveNumber: Number(fenBefore.split(" ")[5]),
      color: m.color,
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ""),
      from: m.from,
      to: m.to,
      fenBefore,
      fenAfter: m.after,
      legalMoveCount,
      clockSeconds: parseClock(comments.get(m.after)),
    };
  });
  return { headers, startFen, plies, fens: [startFen, ...plies.map((p) => p.fenAfter)] };
}

/** Converts a line of UCI moves to SAN, stopping at the first illegal move. */
export function uciLineToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of uciMoves) {
    try {
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      out.push(move.san);
    } catch {
      break;
    }
  }
  return out;
}

/** "12. Nf3 Nc6 13. Bb5" style rendering of a SAN line starting at `fen`. */
export function formatLine(fen: string, san: string[]): string {
  const [, turn, , , , full] = fen.split(" ");
  let moveNo = Number(full);
  let white = turn === "w";
  const parts: string[] = [];
  san.forEach((m, i) => {
    if (white) parts.push(`${moveNo}. ${m}`);
    else parts.push(i === 0 ? `${moveNo}... ${m}` : m);
    if (!white) moveNo++;
    white = !white;
  });
  return parts.join(" ");
}

export function moveLabel(ply: Pick<Ply, "moveNumber" | "color" | "san">): string {
  return `${ply.moveNumber}${ply.color === "w" ? "." : "..."} ${ply.san}`;
}
