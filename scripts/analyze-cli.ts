// Command-line version of the analyzer:
//   npm run analyze -- game.pgn [--depth 18] [--name yourname | --color w|b] [--json]
import { readFileSync } from "node:fs";
import { analyzePositions } from "../src/analysis/analyze.ts";
import { buildCoaching, detectColor, fmtPct } from "../src/analysis/insights.ts";
import { formatLine, moveLabel, parseGame, splitPgn } from "../src/analysis/pgn.ts";
import { reviewGame } from "../src/analysis/review.ts";
import { formatScore, type Color } from "../src/analysis/score.ts";
import { createNodeEngine } from "../src/engine/node.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file) {
  console.error("Usage: npm run analyze -- game.pgn [--depth 18] [--name you | --color w|b] [--game N] [--json]");
  process.exit(1);
}

const games = splitPgn(readFileSync(file, "utf8"));
const game = parseGame(games[Number(opt("game") ?? 1) - 1] ?? "");
const depth = Number(opt("depth") ?? 18);
const color: Color = (opt("color") as Color) ?? detectColor(game.headers, opt("name") ?? "") ?? "w";

const engine = await createNodeEngine(opt("engine"));
const positions = await analyzePositions(engine, game.fens, { depth, multipv: 3 }, {
  onProgress: (done, total) => process.stderr.write(`\ranalyzing ${done}/${total}`),
});
process.stderr.write("\n");
engine.quit();

const review = reviewGame(game, positions);
const coaching = buildCoaching(review, color);

if (args.includes("--json")) {
  console.log(JSON.stringify({ review: { ...review, game: undefined }, coaching }, null, 2));
  process.exit(0);
}

const h = game.headers;
console.log(`${h.White} vs ${h.Black} ${h.Result ?? ""} — reviewing as ${color === "w" ? "White" : "Black"}, depth ${depth}`);
console.log(coaching.headline);
console.log(`Opponent accuracy ${fmtPct(coaching.opponentSummary.accuracy)}\n`);
for (const m of review.moves) {
  const mark = m.ply.color === color ? "*" : " ";
  const best = m.isBest ? "" : `  best ${m.bestLine.san[0]} (${formatScore(m.bestScore)})`;
  console.log(
    `${mark} ${moveLabel(m.ply).padEnd(14)} ${m.classification.padEnd(10)} ${formatScore(m.playedScore).padStart(6)}  -${m.winLoss.toFixed(1).padStart(4)}%${best}${
      m.tags.length ? `  [${m.tags.join(", ")}]` : ""
    }`,
  );
}
console.log("\nKey moments:");
for (const m of coaching.keyMoments) {
  console.log(`  ${moveLabel(m.ply)} (${m.classification}) — engine: ${formatLine(m.ply.fenBefore, m.bestLine.san.slice(0, 6))}`);
  if (m.refutation) console.log(`      punished by: ${formatLine(m.ply.fenAfter, m.refutation.san.slice(0, 6))}`);
}
console.log("\nWhat to work on:");
coaching.recommendations.forEach((r, i) => console.log(`  ${i + 1}. ${r.title}\n     ${r.why}\n     → ${r.drill}`));
if (coaching.strengths.length) console.log(`\nWhat went well:\n  ${coaching.strengths.join("\n  ")}`);
