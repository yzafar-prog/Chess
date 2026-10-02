// Evaluation math. Every Score in the app is from White's point of view.
import type { UciScore } from "../engine/uci.ts";

export type Color = "w" | "b";

/** cp: centipawns for White. mate: moves until mate (0 = already mated), winner says who mates. */
export type Score = { cp: number } | { mate: number; winner: Color };

export const MATE_CP = 1000;

export function fromUci(score: UciScore, sideToMove: Color): Score {
  if ("cp" in score) return { cp: sideToMove === "w" ? score.cp : -score.cp };
  const moverMates = score.mate > 0;
  const winner: Color = moverMates === (sideToMove === "w") ? "w" : "b";
  return { mate: Math.abs(score.mate), winner };
}

/** Centipawns for White, with mates clamped to ±1000 (lichess convention for ACPL). */
export function toCp(score: Score): number {
  if ("cp" in score) return Math.max(-MATE_CP, Math.min(MATE_CP, score.cp));
  return score.winner === "w" ? MATE_CP : -MATE_CP;
}

/** Lichess win-probability model: centipawns -> White's winning chances in [0, 100]. */
export function winPercent(score: Score): number {
  if ("mate" in score) return score.winner === "w" ? 100 : 0;
  const cp = Math.max(-MATE_CP, Math.min(MATE_CP, score.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function forColor(whiteValue: number, color: Color, kind: "win" | "cp"): number {
  if (color === "w") return whiteValue;
  return kind === "win" ? 100 - whiteValue : -whiteValue;
}

export function isMateFor(score: Score, color: Color): boolean {
  return "mate" in score && score.winner === color;
}

/** Lichess per-move accuracy from a win% drop. */
export function moveAccuracy(winLoss: number): number {
  const raw = 103.1668 * Math.exp(-0.04354 * Math.max(0, winLoss)) - 3.1669 + 1;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Lichess game accuracy: the average of a volatility-weighted mean and the
 * harmonic mean of per-move accuracies. Moves played in sharp, swingy stretches
 * of the game count for more than moves in quiet ones.
 *
 * @param whiteWins White's win% for every position (start + after each move).
 * @param moves the moves to score: their ply index and per-move accuracy.
 */
export function lichessGameAccuracy(whiteWins: number[], moves: { index: number; accuracy: number }[]): number | null {
  if (moves.length === 0) return null;
  const plies = whiteWins.length - 1;
  const window = Math.max(2, Math.min(8, Math.floor(plies / 10)));
  const volatility = (i: number) => {
    const start = Math.max(0, Math.min(i + 1 - window, whiteWins.length - window));
    return Math.max(0.5, Math.min(12, stdev(whiteWins.slice(start, start + window))));
  };
  let sum = 0;
  let weights = 0;
  for (const m of moves) {
    const w = volatility(m.index);
    sum += m.accuracy * w;
    weights += w;
  }
  const harmonic = moves.length / moves.reduce((a, m) => a + 1 / Math.max(m.accuracy, 1), 0);
  return (sum / weights + harmonic) / 2;
}

function stdev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

export function formatScore(score: Score): string {
  if ("mate" in score) {
    if (score.mate === 0) return score.winner === "w" ? "1-0" : "0-1";
    return `${score.winner === "w" ? "" : "-"}M${score.mate}`;
  }
  const pawns = score.cp / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

export function describeScore(score: Score): string {
  if ("mate" in score) {
    const side = score.winner === "w" ? "White" : "Black";
    return score.mate === 0 ? `${side} has delivered mate` : `${side} mates in ${score.mate}`;
  }
  const abs = Math.abs(score.cp);
  const side = score.cp > 0 ? "White" : "Black";
  if (abs < 30) return "equal";
  if (abs < 90) return `${side} slightly better`;
  if (abs < 200) return `${side} clearly better`;
  if (abs < 500) return `${side} winning`;
  return `${side} decisively winning`;
}
