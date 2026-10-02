// Coaching layer: aggregates engine-verified move reviews into findings and
// recommendations. Everything here is derived from engine numbers; nothing is
// guessed.
import { formatLine, moveLabel } from "./pgn.ts";
import { forColor, formatScore, lichessGameAccuracy, winPercent, type Color } from "./score.ts";
import { SEVERITY, type GameReview, type MoveReview, type MoveTag, type Phase, type SideSummary } from "./review.ts";

export interface PhaseStats {
  moves: number;
  accuracy: number | null;
  acpl: number;
  errors: number;
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  drill: string;
  /** Ply indexes that illustrate the finding. */
  evidence: number[];
  weight: number;
}

export interface Coaching {
  color: Color;
  player: string;
  opponent: string;
  summary: SideSummary;
  opponentSummary: SideSummary;
  phases: Record<Phase, PhaseStats>;
  headline: string;
  keyMoments: MoveReview[];
  missedChances: MoveReview[];
  strengths: string[];
  recommendations: Recommendation[];
  peak?: { move: MoveReview; win: number };
  /** Your move after which the engine rated the game as lost and it never recovered. */
  turningPoint?: MoveReview;
  result: string;
}

const PHASES: Phase[] = ["opening", "middlegame", "endgame"];

interface TagAdvice {
  title: string;
  why: (n: number) => string;
  drill: string;
  weight: number;
}

const TAG_ADVICE: Partial<Record<MoveTag, TagAdvice>> = {
  "allowed-mate": {
    title: "King safety: you allowed a forced mate",
    why: (n) => `${n} move${n > 1 ? "s" : ""} let the opponent force checkmate (engine-confirmed mating line shown with each).`,
    drill:
      "Before every move, list every check your opponent would have afterwards. Practise mating-pattern puzzles (back rank, smothered, Greek gift) until you spot them instantly.",
    weight: 10,
  },
  "hung-piece": {
    title: "Pieces moved to squares where they could be taken",
    why: (n) =>
      `${n} time${n > 1 ? "s" : ""} the opponent's best reply simply captured the piece you had just moved, winning material.`,
    drill:
      "Blunder check before you release the piece: 'Is the destination square attacked? Is it defended enough?' Do it on every move, even obvious ones.",
    weight: 9,
  },
  "allowed-tactic": {
    title: "Allowing opponent tactics",
    why: (n) =>
      `${n} move${n > 1 ? "s" : ""} left a tactic for the opponent that wins material (see the refutation lines).`,
    drill:
      "After choosing a move, look at the board from your opponent's side: what are their checks, captures and threats now? 15 minutes of tactics puzzles a day trains this fastest.",
    weight: 8,
  },
  "missed-mate": {
    title: "Missed forced mates",
    why: (n) => `The engine found a forced mate for you ${n} time${n > 1 ? "s" : ""} that you didn't play.`,
    drill: "When the enemy king is exposed, always calculate every check first. Mate-in-2/3 puzzles build this.",
    weight: 7,
  },
  "missed-tactic": {
    title: "Missed tactics that won material",
    why: (n) =>
      `${n} time${n > 1 ? "s" : ""} the engine's best move won material by force and you played something else.`,
    drill:
      "Scan for forcing moves (checks, captures, threats) for yourself on every move before considering quiet ones. Study the engine line at each of these moments and replay it.",
    weight: 7,
  },
  "threw-advantage": {
    title: "Converting winning positions",
    why: (n) => `${n} serious error${n > 1 ? "s" : ""} came when you were already clearly better.`,
    drill:
      "When ahead: trade pieces (not pawns), remove the opponent's counterplay before pushing your own plans, and double-check forcing replies. Practise 'win the won position' drills against an engine.",
    weight: 6,
  },
  "under-pressure": {
    title: "Defending worse positions",
    why: (n) => `${n} serious error${n > 1 ? "s" : ""} came when you were already worse, turning a difficult game into a lost one.`,
    drill:
      "In bad positions, look for active defence and forcing resources rather than passive moves; aim to set practical problems. Replay these positions against the engine from the critical moment.",
    weight: 4,
  },
  positional: {
    title: "Strategic / positional mistakes",
    why: (n) =>
      `${n} costly move${n > 1 ? "s" : ""} lost no material in the short term, but the engine judged the resulting position much worse — a plan or structure problem rather than a tactic.`,
    drill:
      "At each of these moments compare your move with the engine's plan: which piece was worst placed, which pawn break mattered, which weakness did you create? Studying annotated master games in your openings helps most here.",
    weight: 5,
  },
  "missed-punish": {
    title: "Not punishing opponent mistakes",
    why: (n) => `${n} time${n > 1 ? "s" : ""} your opponent erred and your reply gave a large part of the gift back.`,
    drill:
      "When your opponent's move surprises you, ask 'what did that move change? What is now undefended?' before continuing with your plan.",
    weight: 5,
  },
  "only-move-missed": {
    title: "Critical moments",
    why: (n) =>
      `${n} position${n > 1 ? "s" : ""} had only one good move (every alternative was at least 15% worse in winning chances) and you missed it.`,
    drill:
      "Learn to recognise critical moments (sharp tactics, open kings, imminent pawn breaks) and spend your clock time there instead of on routine moves.",
    weight: 4,
  },
  "time-trouble": {
    title: "Time management",
    why: (n) => `${n} move${n > 1 ? "s were" : " was"} played with very little time left on the clock.`,
    drill:
      "Budget your clock: move faster in familiar opening positions and spend the saved time at critical moments. Practise at a slightly longer time control.",
    weight: 3,
  },
};

const PHASE_ADVICE: Record<Phase, string> = {
  opening:
    "Review the opening moves where the engine disagreed with you and build a small repertoire file for these lines. Focus on understanding the plans, not memorising moves.",
  middlegame:
    "Middlegame play cost the most. Practise calculation (tactics puzzles, then longer 'calculate to the end' exercises) and study typical plans for your pawn structures.",
  endgame:
    "Endgame play cost the most. Study fundamental endgames (king activity, rook endings, pawn races) — they come up in nearly every long game.",
};

function phaseStats(moves: MoveReview[], whiteWins: number[]): PhaseStats {
  const scored = moves.filter((m) => m.classification !== "forced");
  return {
    moves: moves.length,
    accuracy: lichessGameAccuracy(
      whiteWins,
      scored.map((m) => ({ index: m.ply.index, accuracy: m.accuracy })),
    ),
    acpl: scored.length ? scored.reduce((a, m) => a + m.cpLoss, 0) / scored.length : 0,
    errors: moves.filter((m) => SEVERITY[m.classification] >= 2).length,
  };
}

/** Works out which side the user played from a name, or null if unknown. */
export function detectColor(headers: Record<string, string>, name: string): Color | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  if ((headers.White ?? "").toLowerCase() === n) return "w";
  if ((headers.Black ?? "").toLowerCase() === n) return "b";
  if ((headers.White ?? "").toLowerCase().includes(n)) return "w";
  if ((headers.Black ?? "").toLowerCase().includes(n)) return "b";
  return null;
}

export function buildCoaching(review: GameReview, color: Color): Coaching {
  const opp: Color = color === "w" ? "b" : "w";
  const mine = review.moves.filter((m) => m.ply.color === color);
  const theirs = review.moves.filter((m) => m.ply.color === opp);
  const summary = review.summary[color];
  const opponentSummary = review.summary[opp];
  const whiteWins = review.positions.map((p) => winPercent(p.score));
  const headers = review.game.headers;

  const phases = Object.fromEntries(
    PHASES.map((p) => [p, phaseStats(mine.filter((m) => m.phase === p), whiteWins)]),
  ) as Record<Phase, PhaseStats>;

  const keyMoments = mine
    .filter((m) => SEVERITY[m.classification] >= 1)
    .sort((a, b) => b.winLoss - a.winLoss)
    .slice(0, 5)
    .sort((a, b) => a.ply.index - b.ply.index);

  // Turning point: after this move of yours the position was lost for good.
  // Accuracy after that point says little (win chances can't drop much further).
  const turningPoint = mine.find(
    (m, i) => m.winAfter < 20 && m.winLoss >= 5 && mine.slice(i + 1).every((later) => later.winBefore < 35),
  );
  // Opponent errors you did not exploit.
  const missedChances = mine
    .filter((m) => m.tags.includes("missed-punish"))
    .sort((a, b) => b.winLoss - a.winLoss)
    .slice(0, 3);

  // Tag-driven recommendations.
  const recommendations: Recommendation[] = [];
  const byTag = new Map<MoveTag, MoveReview[]>();
  for (const m of mine) for (const t of m.tags) byTag.set(t, [...(byTag.get(t) ?? []), m]);
  for (const [tag, list] of byTag) {
    const advice = TAG_ADVICE[tag];
    if (!advice) continue;
    const cost = list.reduce((a, m) => a + m.winLoss, 0);
    recommendations.push({
      id: tag,
      title: advice.title,
      why: advice.why(list.length),
      drill: advice.drill,
      evidence: list.map((m) => m.ply.index),
      weight: advice.weight * list.length + cost / 10,
    });
  }

  // Weakest phase (needs a handful of moves to be meaningful).
  const phaseRanked = PHASES.filter((p) => phases[p].moves >= 4 && phases[p].accuracy !== null).sort(
    (a, b) => (phases[a].accuracy ?? 100) - (phases[b].accuracy ?? 100),
  );
  const weakest = phaseRanked[0];
  const strongest = phaseRanked[phaseRanked.length - 1];
  // Skipped after a turning point: phases played in a lost position look
  // artificially accurate, so the comparison would mislead.
  if (!turningPoint && weakest && phaseRanked.length >= 2 && (phases[weakest].accuracy ?? 100) < 85) {
    const weakMoves = mine.filter((m) => m.phase === weakest && SEVERITY[m.classification] >= 1);
    recommendations.push({
      id: `phase-${weakest}`,
      title: `Weakest phase: the ${weakest}`,
      why: `Your accuracy was ${fmtPct(phases[weakest].accuracy)} in the ${weakest} versus ${fmtPct(
        phases[strongest].accuracy,
      )} in the ${strongest}.`,
      drill: PHASE_ADVICE[weakest],
      evidence: weakMoves.map((m) => m.ply.index),
      weight: 3 + (100 - (phases[weakest].accuracy ?? 100)) / 10,
    });
  }

  // Opening: first real deviation from the engine's preference.
  const firstSlip = mine.find((m) => m.phase === "opening" && m.winLoss >= 5);
  if (firstSlip) {
    recommendations.push({
      id: "opening-slip",
      title: `Opening: first inaccuracy at ${moveLabel(firstSlip.ply)}`,
      why: `${headers.Opening ? `In the ${headers.Opening}, the` : "The"} engine preferred ${
        firstSlip.bestLine.san[0]
      } (${formatScore(firstSlip.bestScore)}) over your ${firstSlip.ply.san} (${formatScore(
        firstSlip.playedScore,
      )}).`,
      drill: `Look up this position in an opening database and learn the main idea behind ${firstSlip.bestLine.san[0]}: ${formatLine(
        firstSlip.ply.fenBefore,
        firstSlip.bestLine.san.slice(0, 6),
      )}.`,
      evidence: [firstSlip.ply.index],
      weight: 2.5,
    });
  }
  recommendations.sort((a, b) => b.weight - a.weight);

  // Peak advantage and conversion.
  let peak: Coaching["peak"];
  for (const m of review.moves) {
    const win = forColor(winPercent(m.playedScore), color, "win");
    if (!peak || win > peak.win) peak = { move: m, win };
  }
  const result = headers.Result ?? "*";
  const won = (result === "1-0" && color === "w") || (result === "0-1" && color === "b");
  if (peak && peak.win >= 85 && !won && result !== "*") {
    recommendations.unshift({
      id: "conversion",
      title: "A winning position slipped away",
      why: `After ${moveLabel(peak.move.ply)} the engine rated your position ${formatScore(
        peak.move.playedScore,
      )} (${peak.win.toFixed(0)}% winning chances), but the game ended ${result}.`,
      drill: TAG_ADVICE["threw-advantage"]!.drill,
      evidence: [peak.move.ply.index],
      weight: 100,
    });
  }

  if (turningPoint) {
    recommendations.push({
      id: "turning-point",
      title: `Turning point: ${moveLabel(turningPoint.ply)}`,
      why: `After this move the engine rated your position ${formatScore(turningPoint.playedScore)} (${turningPoint.winAfter.toFixed(
        0,
      )}% winning chances) and it never recovered. The engine wanted ${turningPoint.bestLine.san[0]} (${formatScore(
        turningPoint.bestScore,
      )}). Moves after this point count for little in the accuracy figures, so focus your review on the moves leading up to it.`,
      drill: `Replay the position before ${moveLabel(turningPoint.ply)} and work through the engine line: ${formatLine(
        turningPoint.ply.fenBefore,
        turningPoint.bestLine.san.slice(0, 6),
      )}.`,
      evidence: [turningPoint.ply.index],
      weight: 20,
    });
    recommendations.sort((a, b) => b.weight - a.weight);
  }

  // Strengths, grounded in the same numbers. Accuracy praise is skipped once
  // the game was already lost, because it would be misleading.
  const strengths: string[] = [];
  if (!turningPoint && summary.accuracy !== null && summary.accuracy >= 85)
    strengths.push(`High overall accuracy (${fmtPct(summary.accuracy)}).`);
  if (!turningPoint && strongest && phaseRanked.length >= 2 && (phases[strongest].accuracy ?? 0) >= 80)
    strengths.push(`Solid ${strongest} play (${fmtPct(phases[strongest].accuracy)} accuracy).`);
  const found = mine.filter((m) => m.tags.includes("only-move-found"));
  if (found.length) strengths.push(`Found the only good move in ${found.length} critical position${found.length > 1 ? "s" : ""}: ${found.slice(0, 4).map((m) => moveLabel(m.ply)).join(", ")}.`);
  const punished = theirs.filter((t) => {
    const reply = mine.find((m) => m.ply.index === t.ply.index + 1);
    return SEVERITY[t.classification] >= 2 && reply && SEVERITY[reply.classification] === 0;
  });
  if (punished.length) strengths.push(`Punished ${punished.length} of your opponent's mistakes with an accurate reply.`);
  if (!turningPoint && summary.counts.blunder === 0 && summary.counts.mistake === 0 && summary.moves >= 15)
    strengths.push("No mistakes or blunders.");

  const headline = [
    summary.accuracy !== null ? `Accuracy ${fmtPct(summary.accuracy)}` : null,
    `${summary.counts.blunder} blunder${summary.counts.blunder === 1 ? "" : "s"}`,
    `${summary.counts.mistake} mistake${summary.counts.mistake === 1 ? "" : "s"}`,
    `${summary.counts.inaccuracy} inaccurac${summary.counts.inaccuracy === 1 ? "y" : "ies"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    color,
    player: (color === "w" ? headers.White : headers.Black) ?? (color === "w" ? "White" : "Black"),
    opponent: (color === "w" ? headers.Black : headers.White) ?? (color === "w" ? "Black" : "White"),
    summary,
    opponentSummary,
    phases,
    headline,
    keyMoments,
    missedChances,
    strengths,
    recommendations,
    peak,
    turningPoint,
    result,
  };
}

export function fmtPct(v: number | null): string {
  return v === null ? "–" : `${v.toFixed(1)}%`;
}
