// Evaluation graph: White's winning chances over the game, as an SVG.
import type { GameReview } from "../analysis/review.ts";
import { formatScore, winPercent } from "../analysis/score.ts";

const W = 1000;
const H = 180;

export function renderGraph(
  host: HTMLElement,
  review: GameReview,
  current: number,
  onSelect: (positionIndex: number) => void,
): void {
  const n = review.positions.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (win: number) => H - (win / 100) * H;
  const pts = review.positions.map((p, i) => [x(i), y(winPercent(p.score))] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const dots = review.moves
    .filter((m) => m.classification === "mistake" || m.classification === "blunder" || m.classification === "inaccuracy")
    .map((m) => {
      const i = m.ply.index + 1;
      const [px, py] = pts[i];
      return `<circle class="dot ${m.classification}" cx="${px}" cy="${py}" r="6"><title>${m.ply.moveNumber}${
        m.ply.color === "w" ? "." : "..."
      } ${m.ply.san} — ${m.classification} (${formatScore(m.playedScore)})</title></circle>`;
    })
    .join("");
  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evaluation graph">
      <rect class="bg" x="0" y="0" width="${W}" height="${H}" />
      <path class="area" d="${area}" />
      <line class="mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" />
      <line class="cursor" x1="${x(current)}" y1="0" x2="${x(current)}" y2="${H}" />
      <path class="line" d="${line}" />
      ${dots}
    </svg>`;
  const svg = host.querySelector("svg")!;
  svg.onclick = (e) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSelect(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };
}
