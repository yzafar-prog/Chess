// Turns raw per-position engine evaluations into per-move judgements:
// how much each move cost, its classification, and pattern tags.
import { Chess } from "chess.js";
import type { EngineLine, PositionEval } from "./analyze.ts";
import type { ParsedGame, Ply } from "./pgn.ts";
import {
  forColor,
  lichessGameAccuracy,
  isMateFor,
  moveAccuracy,
  toCp,
  winPercent,
  type Color,
  type Score,
} from "./score.ts";

export type MoveClass = "best" | "excellent" | "good" | "inaccuracy" | "mistake" | "blunder" | "forced";
export type Phase = "opening" | "middlegame" | "endgame";

export type MoveTag =
  | "missed-mate"
  | "allowed-mate"
  | "missed-tactic"
  | "hung-piece"
  | "allowed-tactic"
  | "positional"
  | "threw-advantage"
  | "under-pressure"
  | "missed-punish"
  | "only-move-found"
  | "only-move-missed"
  | "time-trouble";

export interface MoveReview {
  ply: Ply;
  phase: Phase;
  /** Engine's evaluation if the best move had been played (White POV). */
  bestScore: Score;
  /** Engine's evaluation after the move actually played (White POV). */
  playedScore: Score;
  bestLine: EngineLine;
  /** Other strong candidate moves from MultiPV. */
  alternatives: EngineLine[];
  /** Opponent's best continuation after the played move: why the move was bad. */
  refutation?: EngineLine;
  isBest: boolean;
  /** Mover's winning chances (0-100) before (with best play) and after the move. */
  winBefore: number;
  winAfter: number;
  winLoss: number;
  cpLoss: number;
  accuracy: number;
  classification: MoveClass;
  tags: MoveTag[];
}

export interface SideSummary {
  accuracy: number | null;
  acpl: number;
  counts: Record<MoveClass, number>;
  moves: number;
}

export interface GameReview {
  game: ParsedGame;
  positions: PositionEval[];
  moves: MoveReview[];
  depth: number;
  summary: Record<Color, SideSummary>;
}

// Thresholds on the drop in winning chances (percentage points). The
// inaccuracy/mistake/blunder cut-offs match lichess's.
const THRESHOLDS = { excellent: 2, good: 5, inaccuracy: 10, mistake: 15 };

export function classify(winLoss: number, isBest: boolean): MoveClass {
  if (isBest || winLoss < 0.5) return "best";
  if (winLoss < THRESHOLDS.excellent) return "excellent";
  if (winLoss < THRESHOLDS.good) return "good";
  if (winLoss < THRESHOLDS.inaccuracy) return "inaccuracy";
  if (winLoss < THRESHOLDS.mistake) return "mistake";
  return "blunder";
}

export const SEVERITY: Record<MoveClass, number> = {
  forced: 0,
  best: 0,
  excellent: 0,
  good: 0,
  inaccuracy: 1,
  mistake: 2,
  blunder: 3,
};

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material balance in pawns, White POV. */
export function material(fen: string): number {
  let total = 0;
  for (const ch of fen.split(" ")[0]) {
    const v = PIECE_VALUE[ch.toLowerCase()];
    if (v !== undefined) total += ch === ch.toUpperCase() ? v : -v;
  }
  return total;
}

/** Non-pawn material of both sides combined, in pawns (62 at the start). */
function pieceMaterial(fen: string): { total: number; queens: number } {
  let total = 0;
  let queens = 0;
  for (const ch of fen.split(" ")[0]) {
    const lower = ch.toLowerCase();
    if ("nbrq".includes(lower)) total += PIECE_VALUE[lower];
    if (lower === "q") queens++;
  }
  return { total, queens };
}

export function phaseOf(fen: string, moveNumber: number): Phase {
  const { total, queens } = pieceMaterial(fen);
  if (total <= 26 || (queens === 0 && total <= 34)) return "endgame";
  if (moveNumber <= 12 && total >= 54) return "opening";
  return "middlegame";
}

/**
 * Material change (for `color`) along a line of UCI moves, measured at the
 * last "quiet" point within `maxPlies` so we don't snapshot mid-exchange.
 */
export function materialSwing(fen: string, uciMoves: string[], color: Color, maxPlies = 6): number {
  const chess = new Chess(fen);
  const start = material(fen);
  let quiet = start;
  const moves = uciMoves.slice(0, maxPlies);
  for (let i = 0; i < moves.length; i++) {
    const u = moves[i];
    try {
      chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch {
      break;
    }
    const next = moves[i + 1];
    const nextIsCapture = next ? isCapture(chess, next) : false;
    if (!nextIsCapture) quiet = material(chess.fen());
  }
  return forColor(quiet - start, color, "cp");
}

function isCapture(chess: Chess, uci: string): boolean {
  const target = chess.get(uci.slice(2, 4) as never);
  if (target) return true;
  const piece = chess.get(uci.slice(0, 2) as never);
  // En passant: pawn moving diagonally to an empty square.
  return !!piece && piece.type === "p" && uci[0] !== uci[2];
}

function sameMove(a: string | undefined, b: string): boolean {
  return !!a && a.slice(0, 4) === b.slice(0, 4) && (a[4] ?? "") === (b[4] ?? "");
}

export function reviewGame(game: ParsedGame, positions: PositionEval[]): GameReview {
  if (positions.length !== game.plies.length + 1) {
    throw new Error("Need one evaluation per position (moves + 1).");
  }
  const initialClock: Partial<Record<Color, number>> = {};
  for (const p of game.plies) if (p.clockSeconds !== undefined && initialClock[p.color] === undefined) initialClock[p.color] = p.clockSeconds;

  const moves: MoveReview[] = [];
  game.plies.forEach((ply, i) => {
    const before = positions[i];
    const after = positions[i + 1];
    const mover = ply.color;
    const opp: Color = mover === "w" ? "b" : "w";
    const bestLine = before.lines[0];
    const matching = before.lines.find((l) => sameMove(l.uci[0], ply.uci));
    const isBest = sameMove(bestLine?.uci[0], ply.uci);
    // Prefer the score from the same search when the played move was one of the
    // MultiPV candidates: comparing like with like avoids depth noise.
    const bestScore = before.score;
    const playedScore = matching ? matching.score : after.score;
    const winBefore = forColor(winPercent(bestScore), mover, "win");
    const winAfter = forColor(winPercent(playedScore), mover, "win");
    const winLoss = Math.max(0, winBefore - winAfter);
    const cpLoss = Math.max(0, forColor(toCp(bestScore) - toCp(playedScore), mover, "cp"));
    const forced = ply.legalMoveCount === 1;
    const classification: MoveClass = forced ? "forced" : classify(winLoss, isBest);

    const tags: MoveTag[] = [];
    const severity = SEVERITY[classification];
    if (isMateFor(bestScore, mover) && !isMateFor(playedScore, mover) && severity >= 1) tags.push("missed-mate");
    if (isMateFor(playedScore, opp) && !isMateFor(bestScore, opp) && severity >= 1) tags.push("allowed-mate");

    const refutation = after.lines[0];
    if (severity >= 1 && bestLine) {
      const bestGain = materialSwing(ply.fenBefore, bestLine.uci, mover);
      const playedGain = materialSwing(ply.fenBefore, [ply.uci, ...(refutation?.uci ?? [])], mover);
      if (bestGain >= 2 && playedGain <= bestGain - 2) tags.push("missed-tactic");
      if (playedGain <= -2) {
        const reply = refutation?.uci[0];
        tags.push(reply && reply.slice(2, 4) === ply.to ? "hung-piece" : "allowed-tactic");
      }
      const materialExplains = tags.some((t) =>
        ["missed-mate", "allowed-mate", "missed-tactic", "hung-piece", "allowed-tactic"].includes(t),
      );
      if (severity >= 2 && !materialExplains) tags.push("positional");
      if (severity >= 2 && winBefore >= 70 && winAfter < 60) tags.push("threw-advantage");
      if (severity >= 2 && winBefore <= 35) tags.push("under-pressure");
    }

    const prev = moves[i - 1];
    if (prev && prev.winLoss >= THRESHOLDS.inaccuracy && winLoss >= THRESHOLDS.good) tags.push("missed-punish");

    if (!forced && before.lines.length >= 2 && winBefore > 10) {
      const second = forColor(winPercent(before.lines[1].score), mover, "win");
      if (winBefore - second >= 15) tags.push(isBest ? "only-move-found" : "only-move-missed");
    }

    const clock = ply.clockSeconds;
    const initial = initialClock[mover];
    if (clock !== undefined && (clock <= 30 || (initial !== undefined && initial >= 60 && clock <= initial * 0.1))) {
      tags.push("time-trouble");
    }

    moves.push({
      ply,
      phase: phaseOf(ply.fenBefore, ply.moveNumber),
      bestScore,
      playedScore,
      bestLine,
      alternatives: before.lines.slice(1),
      refutation,
      isBest,
      winBefore,
      winAfter,
      winLoss,
      cpLoss,
      accuracy: moveAccuracy(winLoss),
      classification,
      tags,
    });
  });

  return {
    game,
    positions,
    moves,
    depth: Math.max(...positions.map((p) => p.depth)),
    summary: { w: summarize(moves, "w", positions), b: summarize(moves, "b", positions) },
  };
}

export function summarize(moves: MoveReview[], color: Color, positions: PositionEval[]): SideSummary {
  const mine = moves.filter((m) => m.ply.color === color);
  const counts: Record<MoveClass, number> = {
    best: 0,
    excellent: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
    forced: 0,
  };
  for (const m of mine) counts[m.classification]++;
  const scored = mine.filter((m) => m.classification !== "forced");
  return {
    accuracy: lichessGameAccuracy(
      positions.map((p) => winPercent(p.score)),
      scored.map((m) => ({ index: m.ply.index, accuracy: m.accuracy })),
    ),
    acpl: scored.length ? scored.reduce((a, m) => a + m.cpLoss, 0) / scored.length : 0,
    counts,
    moves: mine.length,
  };
}
