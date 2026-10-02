// Optional: asks Claude to turn the engine's verified findings into a written
// coaching report. Claude never calculates here — it only receives evaluations
// and lines that Stockfish already produced, and every move it mentions is
// checked against that data afterwards.
import Anthropic from "@anthropic-ai/sdk";
import { fmtPct, type Coaching } from "../analysis/insights.ts";
import { formatLine, moveLabel } from "../analysis/pgn.ts";
import type { GameReview, MoveReview } from "../analysis/review.ts";
import { describeScore, formatScore } from "../analysis/score.ts";

export const COACH_MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You are an experienced chess coach writing a post-game review for a club player.

All evaluations and variations you are given were computed by the Stockfish chess engine and are verified. You do not have an engine, and your own move-by-move calculation is unreliable, so:
- Never invent or extend variations. Only cite moves and lines that appear verbatim in the data.
- Never contradict the engine's evaluations. If you are unsure why the engine prefers a move, say what the line shows (e.g. "the engine line wins the knight after ...") rather than speculating.
- When you explain why a move is good or bad, ground the explanation in the provided lines (the engine's best line, and the refutation line showing how the opponent punishes the move played).

Write for the player (address them as "you"). Structure the review in Markdown with these sections:
## Summary — 2-3 sentences on how the game went, using the accuracy numbers and the result.
## Key moments — for each key moment provided: what was played, what the engine wanted, and the idea behind it in plain language (threats, piece activity, king safety, pawn structure). Quote moves in standard algebraic notation with move numbers.
## Patterns in your play — connect the moments to the recurring patterns in the data.
## Training plan — 3 to 5 concrete, prioritised things to work on, tied to the evidence.
Keep it under about 700 words.`;

function momentFacts(m: MoveReview) {
  return {
    move: moveLabel(m.ply),
    phase: m.phase,
    classification: m.classification,
    fen_before: m.ply.fenBefore,
    eval_before_with_best_play: `${formatScore(m.bestScore)} (${describeScore(m.bestScore)})`,
    eval_after_move_played: `${formatScore(m.playedScore)} (${describeScore(m.playedScore)})`,
    winning_chances_lost_pct: Number(m.winLoss.toFixed(1)),
    engine_best_move: m.bestLine.san[0],
    engine_best_line: formatLine(m.ply.fenBefore, m.bestLine.san.slice(0, 8)),
    other_good_moves: m.alternatives.map((a) => `${a.san[0]} (${formatScore(a.score)})`),
    refutation_of_move_played: m.refutation ? formatLine(m.ply.fenAfter, m.refutation.san.slice(0, 8)) : null,
    pattern_tags: m.tags,
  };
}

export function buildFacts(review: GameReview, coaching: Coaching) {
  const h = review.game.headers;
  return {
    engine: `Stockfish 19, depth ${review.depth}, MultiPV`,
    game: {
      white: h.White,
      black: h.Black,
      result: h.Result,
      event: h.Event,
      opening: h.Opening ?? h.ECO,
      time_control: h.TimeControl,
      moves: formatLine(review.game.startFen, review.game.plies.map((p) => p.san)),
    },
    you_played: coaching.color === "w" ? "White" : "Black",
    your_accuracy: fmtPct(coaching.summary.accuracy),
    opponent_accuracy: fmtPct(coaching.opponentSummary.accuracy),
    your_move_counts: coaching.summary.counts,
    your_accuracy_by_phase: Object.fromEntries(
      Object.entries(coaching.phases).map(([p, s]) => [p, { moves: s.moves, accuracy: fmtPct(s.accuracy), serious_errors: s.errors }]),
    ),
    key_moments: coaching.keyMoments.map(momentFacts),
    missed_chances_after_opponent_errors: coaching.missedChances.map(momentFacts),
    turning_point: coaching.turningPoint ? momentFacts(coaching.turningPoint) : null,
    peak_advantage: coaching.peak
      ? { after: moveLabel(coaching.peak.move.ply), eval: formatScore(coaching.peak.move.playedScore) }
      : null,
    detected_patterns: coaching.recommendations.map((r) => ({ finding: r.title, evidence: r.why })),
    strengths: coaching.strengths,
  };
}

/** Every SAN move that appears anywhere in the engine data we sent. */
function knownMoves(review: GameReview): Set<string> {
  const known = new Set<string>();
  const add = (san: string) => known.add(san.replace(/[+#!?]+$/, ""));
  review.game.plies.forEach((p) => add(p.san));
  for (const pos of review.positions) for (const l of pos.lines) l.san.forEach(add);
  return known;
}

// Piece moves, captures, promotions and castling. Bare pawn pushes like "e4"
// are skipped because they are indistinguishable from square names in prose.
const SAN_RE = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][18]=[QRBN])[+#]?|\bO-O(?:-O)?\b/g;

/** Moves Claude mentioned that do not appear in any engine line or the game itself. */
export function unverifiedMoves(text: string, review: GameReview): string[] {
  const known = knownMoves(review);
  const found = new Set<string>();
  for (const match of text.matchAll(SAN_RE)) {
    const san = match[0].replace(/[+#]+$/, "");
    if (!known.has(san)) found.add(match[0]);
  }
  return [...found];
}

export interface CoachCallbacks {
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export async function writeCoachingReport(
  apiKey: string,
  review: GameReview,
  coaching: Coaching,
  { onText, signal }: CoachCallbacks,
): Promise<string> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const facts = buildFacts(review, coaching);
  const stream = client.beta.messages.stream(
    {
      model: COACH_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the engine-verified analysis of my game as JSON. Write my review.\n\n${JSON.stringify(facts, null, 2)}`,
        },
      ],
    },
    { signal },
  );
  stream.on("text", onText);
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to write this review.");
  }
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it and try again.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a moment and retry.";
  if (err instanceof Anthropic.APIUserAbortError) return "Cancelled.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}
