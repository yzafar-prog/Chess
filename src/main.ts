import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import "./style.css";

import { Chessground } from "@lichess-org/chessground";
import type { Api as BoardApi } from "@lichess-org/chessground/api";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { analyzePositions, evaluatePosition, type EngineLine, type PositionEval } from "./analysis/analyze.ts";
import { buildCoaching, detectColor, fmtPct, type Coaching } from "./analysis/insights.ts";
import { formatLine, moveLabel, parseGame, splitPgn, type ParsedGame } from "./analysis/pgn.ts";
import { reviewGame, SEVERITY, type GameReview, type MoveClass, type MoveReview, type MoveTag } from "./analysis/review.ts";
import { describeScore, formatScore, winPercent, type Color } from "./analysis/score.ts";
import { describeApiError, unverifiedMoves, writeCoachingReport } from "./coach/claude.ts";
import { createBrowserEngine, fullEngineAvailable, type EngineFlavor } from "./engine/browser.ts";
import type { UciEngine } from "./engine/uci.ts";
import { renderGraph } from "./ui/graph.ts";
import { escapeHtml, renderMarkdown } from "./ui/markdown.ts";
import { SAMPLE_PGN } from "./ui/sample.ts";

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (el: HTMLElement, visible = true) => el.classList.toggle("hidden", !visible);

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`chess-analyzer:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(`chess-analyzer:${key}`);
      else localStorage.setItem(`chess-analyzer:${key}`, value);
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};

// ---------- State ----------
interface Variation {
  label: string;
  fen: string;
  lastMove?: [Key, Key];
}

const state = {
  engine: null as UciEngine | null,
  engineFlavor: null as EngineFlavor | null,
  games: [] as string[],
  review: null as GameReview | null,
  coaching: null as Coaching | null,
  color: "w" as Color,
  index: 0,
  variation: null as Variation | null,
  deepCheck: new Map<string, PositionEval>(),
  abort: null as AbortController | null,
  claudeAbort: null as AbortController | null,
};

let board: BoardApi | null = null;

const CLASS_LABEL: Record<MoveClass, string> = {
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
  forced: "Forced",
};
const CLASS_GLYPH: Partial<Record<MoveClass, string>> = { inaccuracy: "?!", mistake: "?", blunder: "??" };

const TAG_LABEL: Record<MoveTag, string> = {
  "missed-mate": "Missed a forced mate",
  "allowed-mate": "Allowed a forced mate",
  "missed-tactic": "Missed a tactic that wins material",
  "hung-piece": "Moved a piece where it can be taken",
  "allowed-tactic": "Allowed a tactic",
  positional: "Positional / strategic error",
  "threw-advantage": "Gave away a winning advantage",
  "under-pressure": "Error while defending a worse position",
  "missed-punish": "Didn't punish the opponent's mistake",
  "only-move-found": "Found the only good move",
  "only-move-missed": "Critical moment: only one move held",
  "time-trouble": "Played in time trouble",
};

// ---------- Settings ----------
const pgnInput = $<HTMLTextAreaElement>("pgn");
const nameInput = $<HTMLInputElement>("player-name");
const sideSelect = $<HTMLSelectElement>("side");
const depthSelect = $<HTMLSelectElement>("depth");
const flavorSelect = $<HTMLSelectElement>("engine-flavor");
const gameSelect = $<HTMLSelectElement>("game-select");
const apiKeyInput = $<HTMLInputElement>("api-key");
const rememberKey = $<HTMLInputElement>("remember-key");

nameInput.value = store.get("name") ?? "";
depthSelect.value = store.get("depth") ?? "16";
pgnInput.value = store.get("pgn") ?? "";
const savedKey = store.get("api-key");
if (savedKey) {
  apiKeyInput.value = savedKey;
  rememberKey.checked = true;
}
nameInput.addEventListener("change", () => {
  store.set("name", nameInput.value.trim());
  if (state.review) applyColor();
});
depthSelect.addEventListener("change", () => store.set("depth", depthSelect.value));
sideSelect.addEventListener("change", () => state.review && applyColor());
rememberKey.addEventListener("change", () => store.set("api-key", rememberKey.checked ? apiKeyInput.value : null));
apiKeyInput.addEventListener("change", () => rememberKey.checked && store.set("api-key", apiKeyInput.value));

fullEngineAvailable().then((ok) => {
  const opt = flavorSelect.querySelector<HTMLOptionElement>('option[value="full"]')!;
  opt.disabled = !ok;
  if (ok) opt.textContent = "Stockfish 19 full (strongest, ~99 MB download)";
});

// ---------- PGN input ----------
function refreshGameList() {
  state.games = splitPgn(pgnInput.value);
  gameSelect.innerHTML = "";
  state.games.forEach((g, i) => {
    let label = `Game ${i + 1}`;
    try {
      const h = parseGame(g).headers;
      label = `${i + 1}. ${h.White ?? "?"} – ${h.Black ?? "?"} ${h.Result ?? ""} ${h.Date ? `(${h.Date})` : ""}`;
    } catch {
      label += " (unreadable)";
    }
    gameSelect.append(new Option(label, String(i)));
  });
  show(gameSelect, state.games.length > 1);
}
pgnInput.addEventListener("input", refreshGameList);
refreshGameList();

$("sample").addEventListener("click", () => {
  pgnInput.value = SAMPLE_PGN;
  sideSelect.value = "b";
  refreshGameList();
});

$<HTMLInputElement>("pgn-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  pgnInput.value = await file.text();
  refreshGameList();
});

function showInputError(msg: string | null) {
  const el = $("input-error");
  el.textContent = msg ?? "";
  show(el, !!msg);
}

// ---------- Engine ----------
function setEngineStatus(text: string, ready = false) {
  const el = $("engine-status");
  el.textContent = text;
  el.classList.toggle("ready", ready);
}

async function getEngine(): Promise<UciEngine> {
  const flavor = flavorSelect.value as EngineFlavor;
  if (state.engine && state.engineFlavor === flavor) return state.engine;
  state.engine?.quit();
  state.engine = null;
  setEngineStatus("Engine: loading…");
  const engine = await createBrowserEngine(flavor);
  state.engine = engine;
  state.engineFlavor = flavor;
  setEngineStatus(engine.info.name, true);
  return engine;
}

// ---------- Analysis run ----------
const analyzeBtn = $<HTMLButtonElement>("analyze");

analyzeBtn.addEventListener("click", runAnalysis);
$("cancel").addEventListener("click", () => state.abort?.abort());

async function runAnalysis() {
  showInputError(null);
  refreshGameList();
  if (state.games.length === 0) return showInputError("Paste a PGN first (or load the sample game).");
  let game: ParsedGame;
  try {
    game = parseGame(state.games[Number(gameSelect.value) || 0]);
  } catch (err) {
    return showInputError((err as Error).message);
  }
  store.set("pgn", pgnInput.value);
  const depth = Number(depthSelect.value);
  const ctrl = new AbortController();
  state.abort = ctrl;
  analyzeBtn.disabled = true;
  show($("progress"));
  setProgress(0, game.fens.length, "Starting engine…");
  try {
    const engine = await getEngine();
    const started = performance.now();
    const positions = await analyzePositions(engine, game.fens, { depth, multipv: 3 }, {
      signal: ctrl.signal,
      onProgress: (done, total) => {
        const elapsed = (performance.now() - started) / 1000;
        const eta = done ? Math.round((elapsed / done) * (total - done)) : 0;
        setProgress(done, total, `Position ${done} of ${total} · depth ${depth} · ~${eta}s left`);
      },
    });
    state.review = reviewGame(game, positions);
    state.deepCheck.clear();
    state.variation = null;
    applyColor();
    show($("results"));
    goTo(firstErrorIndex() ?? 0);
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if ((err as Error).name !== "AbortError") showInputError(`Analysis failed: ${(err as Error).message}`);
  } finally {
    state.abort = null;
    analyzeBtn.disabled = false;
    show($("progress"), false);
  }
}

function setProgress(done: number, total: number, text: string) {
  $("progress-bar").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("progress-text").textContent = text;
}

function applyColor() {
  const review = state.review!;
  let color: Color;
  let note = "";
  if (sideSelect.value === "w" || sideSelect.value === "b") color = sideSelect.value;
  else {
    const detected = detectColor(review.game.headers, nameInput.value);
    color = detected ?? "w";
    if (!detected)
      note = nameInput.value.trim()
        ? `Couldn't find “${nameInput.value.trim()}” in the White/Black tags, so this shows White's perspective.`
        : "Showing White's perspective. Enter your username or pick a side above to switch.";
  }
  state.color = color;
  state.coaching = buildCoaching(review, color);
  board?.set({ orientation: color === "w" ? "white" : "black" });
  renderTitle();
  renderCoaching(note);
  renderMoveList();
  render();
}

function firstErrorIndex(): number | null {
  const m = state.review?.moves.find((m) => m.ply.color === state.color && SEVERITY[m.classification] >= 2);
  return m ? m.ply.index + 1 : null;
}

// ---------- Board ----------
function ensureBoard() {
  if (board) return board;
  board = Chessground($("board"), {
    viewOnly: true,
    coordinates: true,
    orientation: state.color === "w" ? "white" : "black",
    animation: { enabled: true, duration: 150 },
    drawable: { enabled: false, visible: true },
  });
  return board;
}

function goTo(index: number) {
  if (!state.review) return;
  state.index = Math.max(0, Math.min(state.review.positions.length - 1, index));
  state.variation = null;
  render();
}

function showVariation(baseFen: string, san: string[], upTo: number, label: string) {
  const chess = new Chess(baseFen);
  let last: [Key, Key] | undefined;
  for (const m of san.slice(0, upTo + 1)) {
    const mv = chess.move(m);
    last = [mv.from as Key, mv.to as Key];
  }
  state.variation = { fen: chess.fen(), lastMove: last, label: `${label}: ${formatLine(baseFen, san.slice(0, upTo + 1))}` };
  render();
}

function currentMove(): MoveReview | null {
  return state.index > 0 ? state.review!.moves[state.index - 1] : null;
}

function render() {
  const review = state.review;
  if (!review) return;
  const cg = ensureBoard();
  const pos = review.positions[state.index];
  const move = currentMove();
  const variation = state.variation;
  const fen = variation?.fen ?? pos.fen;
  const chess = new Chess(fen);
  const shapes: DrawShape[] = [];
  if (!variation && move && !move.isBest && move.classification !== "forced") {
    const best = move.bestLine.uci[0];
    if (best) shapes.push({ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: "green" });
    const reply = move.refutation?.uci[0];
    if (reply && SEVERITY[move.classification] >= 1)
      shapes.push({ orig: reply.slice(0, 2) as Key, dest: reply.slice(2, 4) as Key, brush: "red" });
  }
  cg.set({
    fen,
    lastMove: variation ? variation.lastMove : move ? [move.ply.from as Key, move.ply.to as Key] : undefined,
    check: chess.inCheck() ? (chess.turn() === "w" ? "white" : "black") : false,
  });
  cg.setAutoShapes(shapes);

  // Eval bar shows the game position (variations aren't evaluated).
  const win = winPercent(pos.score);
  $("eval-bar-fill").style.height = `${win}%`;
  $("eval-bar-text").textContent = formatScore(pos.score);
  $("eval-bar").classList.toggle("flipped", state.color === "b");

  show($("variation-banner"), !!variation);
  if (variation) $("variation-text").textContent = variation.label;

  renderDetail();
  renderGraph($("eval-graph"), review, state.index, goTo);
  document.querySelectorAll(".move-list .mv").forEach((el) => {
    el.classList.toggle("active", Number((el as HTMLElement).dataset.index) === state.index);
  });
  document.querySelector(".move-list .mv.active")?.scrollIntoView({ block: "nearest" });
}

// ---------- Panels ----------
function renderTitle() {
  const h = state.review!.game.headers;
  const c = state.coaching!;
  $("game-title").innerHTML = `
    <div><strong>${escapeHtml(h.White ?? "White")}</strong> vs <strong>${escapeHtml(h.Black ?? "Black")}</strong>
    <span class="muted">${escapeHtml([h.Result, h.Event, h.Date].filter(Boolean).join(" · "))}</span></div>
    <div class="muted small">Reviewing as ${c.color === "w" ? "White" : "Black"} (${escapeHtml(c.player)}) ·
    engine depth ${state.review!.depth}</div>`;
}

function lineHtml(baseFen: string, line: EngineLine, label: string, maxPlies = 10): string {
  const chips = formatLineTokens(baseFen, line.san.slice(0, maxPlies));
  return `<div class="line" data-fen="${escapeHtml(baseFen)}" data-san="${escapeHtml(
    line.san.join(" "),
  )}" data-label="${escapeHtml(label)}">${chips}</div>`;
}

function formatLineTokens(fen: string, san: string[]): string {
  const [, turn, , , , full] = fen.split(" ");
  let moveNo = Number(full);
  let white = turn === "w";
  return san
    .map((m, i) => {
      const prefix = white ? `<span class="mvno">${moveNo}.</span>` : i === 0 ? `<span class="mvno">${moveNo}…</span>` : "";
      if (!white) moveNo++;
      white = !white;
      return `${prefix}<button class="chip" data-step="${i}">${escapeHtml(m)}</button>`;
    })
    .join(" ");
}

function renderDetail() {
  const review = state.review!;
  const el = $("move-detail");
  const move = currentMove();
  const pos = review.positions[state.index];
  const parts: string[] = [];

  if (!move) {
    parts.push(`<h2 class="card-title">Starting position</h2>`);
  } else {
    const cls = move.classification;
    const glyph = CLASS_GLYPH[cls] ?? (move.tags.includes("only-move-found") ? "!" : "");
    const mover = move.ply.color === state.color ? "You" : "Opponent";
    parts.push(`
      <div class="detail-head">
        <h2 class="card-title">${escapeHtml(moveLabel(move.ply))}${glyph}</h2>
        <span class="badge ${cls}">${CLASS_LABEL[cls]}</span>
        <span class="muted small">${mover}</span>
      </div>
      <p class="evals">
        Before: <strong>${formatScore(move.bestScore)}</strong> with best play →
        after: <strong>${formatScore(move.playedScore)}</strong>
        <span class="muted">(${describeScore(move.playedScore)})</span><br/>
        <span class="muted small">Winning chances lost: ${move.winLoss.toFixed(1)}% · move accuracy ${move.accuracy.toFixed(0)}%</span>
      </p>`);
    if (move.tags.length)
      parts.push(`<div class="tags">${move.tags.map((t) => `<span class="tag ${t}">${TAG_LABEL[t]}</span>`).join("")}</div>`);
    if (!move.isBest && move.classification !== "forced") {
      parts.push(`<h3>Engine's best move: ${escapeHtml(move.bestLine.san[0] ?? "?")} <span class="muted">(${formatScore(
        move.bestScore,
      )})</span></h3>`);
      parts.push(lineHtml(move.ply.fenBefore, move.bestLine, "Best line"));
      if (move.refutation && SEVERITY[move.classification] >= 1) {
        parts.push(`<h3>Why ${escapeHtml(move.ply.san)} is ${cls === "inaccuracy" ? "inaccurate" : "a " + cls}: the opponent's best reply</h3>`);
        parts.push(lineHtml(move.ply.fenAfter, move.refutation, "Refutation"));
      }
    } else if (move.classification !== "forced") {
      parts.push(`<p class="good-note">This was the engine's top choice.</p>`);
    }
    const alts = move.alternatives.filter((a) => a.san[0] && a.san[0] !== move.ply.san);
    if (alts.length) {
      parts.push(`<h3>Other candidate moves</h3>`);
      for (const a of alts)
        parts.push(`<div class="alt"><span class="score">${formatScore(a.score)}</span>${lineHtml(move.ply.fenBefore, a, "Alternative", 6)}</div>`);
    }
  }

  if (pos.terminal) {
    parts.push(`<p class="muted">Game over: ${pos.terminal}.</p>`);
  } else if (pos.lines[0]) {
    parts.push(`<h3>From here, the engine continues <span class="muted">(${formatScore(pos.score)})</span></h3>`);
    parts.push(lineHtml(pos.fen, pos.lines[0], "Engine line"));
  }

  // Deeper verification of the decision at this move.
  const decisionFen = move ? move.ply.fenBefore : pos.fen;
  const deep = state.deepCheck.get(decisionFen);
  if (deep) {
    parts.push(`<div class="deep"><h3>Deep check at depth ${deep.depth}</h3>${deep.lines
      .map((l) => `<div class="alt"><span class="score">${formatScore(l.score)}</span>${lineHtml(decisionFen, l, "Deep line", 10)}</div>`)
      .join("")}${
      move && deep.lines[0]?.san[0] && deep.lines[0].san[0] !== move.bestLine.san[0]
        ? `<p class="warning">At higher depth the engine now prefers ${escapeHtml(deep.lines[0].san[0])}.</p>`
        : move
          ? `<p class="good-note">Confirmed at depth ${deep.depth}.</p>`
          : ""
    }</div>`);
  } else if (!pos.terminal || move) {
    parts.push(`<button id="deep-btn" class="button secondary small-btn" type="button">Verify this ${
      move ? "decision" : "position"
    } deeper (depth ${deepDepth()})</button>`);
  }
  el.innerHTML = parts.join("");

  el.querySelectorAll<HTMLElement>(".line").forEach((lineEl) => {
    lineEl.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
      chip.addEventListener("click", () =>
        showVariation(lineEl.dataset.fen!, lineEl.dataset.san!.split(" "), Number(chip.dataset.step), lineEl.dataset.label!),
      );
    });
  });
  el.querySelector("#deep-btn")?.addEventListener("click", () => runDeepCheck(decisionFen));
}

function deepDepth() {
  return Math.min(30, Math.max(22, Number(depthSelect.value) + 6));
}

async function runDeepCheck(fen: string) {
  const btn = document.getElementById("deep-btn") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = `Calculating at depth ${deepDepth()}…`;
  }
  try {
    const engine = await getEngine();
    const result = await evaluatePosition(engine, fen, { depth: deepDepth(), multipv: 3 });
    state.deepCheck.set(fen, result);
  } catch (err) {
    if (btn) btn.textContent = `Failed: ${(err as Error).message}`;
    return;
  }
  render();
}

function renderMoveList() {
  const review = state.review!;
  const rows: string[] = [];
  const moves = review.moves;
  const cell = (m: MoveReview | undefined) => {
    if (!m) return `<span class="mv empty"></span>`;
    const glyph = CLASS_GLYPH[m.classification] ?? (m.tags.includes("only-move-found") ? "!" : "");
    const mine = m.ply.color === state.color ? " mine" : "";
    return `<button class="mv ${m.classification}${mine}" data-index="${m.ply.index + 1}" title="${CLASS_LABEL[m.classification]} · ${formatScore(
      m.playedScore,
    )}">${escapeHtml(m.ply.san)}<span class="glyph">${glyph}</span></button>`;
  };
  let i = 0;
  if (moves[0]?.ply.color === "b") {
    rows.push(`<span class="num">${moves[0].ply.moveNumber}.</span>${cell(undefined)}${cell(moves[0])}`);
    i = 1;
  }
  for (; i < moves.length; i += 2) {
    rows.push(`<span class="num">${moves[i].ply.moveNumber}.</span>${cell(moves[i])}${cell(moves[i + 1])}`);
  }
  $("move-list").innerHTML = rows.join("");
  $("move-list")
    .querySelectorAll<HTMLElement>(".mv[data-index]")
    .forEach((b) => b.addEventListener("click", () => goTo(Number(b.dataset.index))));
}

function moveLink(index: number): string {
  const m = state.review!.moves[index];
  return `<button class="link-button jump" data-index="${index + 1}">${escapeHtml(moveLabel(m.ply))}</button>`;
}

function renderCoaching(note: string) {
  const c = state.coaching!;
  const s = c.summary;
  const o = c.opponentSummary;
  const counts = (["best", "excellent", "good", "inaccuracy", "mistake", "blunder"] as MoveClass[])
    .map((k) => `<tr><td><span class="badge ${k}">${CLASS_LABEL[k]}</span></td><td>${s.counts[k]}</td><td>${o.counts[k]}</td></tr>`)
    .join("");
  const phases = (["opening", "middlegame", "endgame"] as const)
    .filter((p) => c.phases[p].moves > 0)
    .map(
      (p) =>
        `<tr><td>${p[0].toUpperCase() + p.slice(1)}</td><td>${c.phases[p].moves}</td><td>${fmtPct(c.phases[p].accuracy)}</td><td>${Math.round(
          c.phases[p].acpl,
        )}</td><td>${c.phases[p].errors}</td></tr>`,
    )
    .join("");
  const recs = c.recommendations
    .slice(0, 6)
    .map(
      (r, i) => `
      <li class="rec">
        <div class="rec-title"><span class="rec-num">${i + 1}</span>${escapeHtml(r.title)}</div>
        <p>${escapeHtml(r.why)}</p>
        <p class="drill"><strong>Work on it:</strong> ${escapeHtml(r.drill)}</p>
        ${r.evidence.length ? `<p class="evidence muted small">See: ${r.evidence.slice(0, 8).map(moveLink).join(", ")}</p>` : ""}
      </li>`,
    )
    .join("");
  const moments = c.keyMoments
    .map(
      (m) => `
      <li>
        ${moveLink(m.ply.index)} <span class="badge ${m.classification}">${CLASS_LABEL[m.classification]}</span>
        <span class="muted">${formatScore(m.bestScore)} → ${formatScore(m.playedScore)}</span>
        — best was <strong>${escapeHtml(m.bestLine.san[0] ?? "?")}</strong>
        ${m.tags.filter((t) => TAG_LABEL[t]).slice(0, 2).map((t) => `<span class="tag ${t}">${TAG_LABEL[t]}</span>`).join("")}
      </li>`,
    )
    .join("");

  $("coaching").innerHTML = `
    <h2 class="card-title">Your coaching report</h2>
    ${note ? `<p class="warning">${escapeHtml(note)}</p>` : ""}
    <p class="headline">${escapeHtml(c.headline)}</p>
    <div class="stats-grid">
      <div class="stat"><div class="stat-label">Your accuracy</div><div class="stat-value">${fmtPct(s.accuracy)}</div>
        <div class="muted small">avg. centipawn loss ${Math.round(s.acpl)}</div></div>
      <div class="stat"><div class="stat-label">${escapeHtml(c.opponent)}</div><div class="stat-value">${fmtPct(o.accuracy)}</div>
        <div class="muted small">avg. centipawn loss ${Math.round(o.acpl)}</div></div>
      <table class="mini"><thead><tr><th></th><th>You</th><th>Opp.</th></tr></thead><tbody>${counts}</tbody></table>
      ${phases ? `<table class="mini"><thead><tr><th>Phase</th><th>Moves</th><th>Accuracy</th><th>ACPL</th><th>Errors</th></tr></thead><tbody>${phases}</tbody></table>` : ""}
    </div>
    <div class="coach-cols">
      <div>
        <h3>What to work on</h3>
        ${recs ? `<ol class="recs">${recs}</ol>` : `<p>No recurring problems detected in this game. Nice.</p>`}
      </div>
      <div>
        <h3>Key moments</h3>
        ${moments ? `<ul class="moments">${moments}</ul>` : `<p class="muted">No inaccuracies or worse — clean game.</p>`}
        ${c.strengths.length ? `<h3>What went well</h3><ul class="strengths">${c.strengths.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : ""}
      </div>
    </div>`;
  $("coaching")
    .querySelectorAll<HTMLElement>(".jump")
    .forEach((b) =>
      b.addEventListener("click", () => {
        goTo(Number(b.dataset.index));
        $("board").scrollIntoView({ behavior: "smooth", block: "center" });
      }),
    );
}

// ---------- Navigation ----------
document.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => navigate(b.dataset.nav!)),
);
$("flip").addEventListener("click", () => board?.toggleOrientation());
$("next-mistake").addEventListener("click", nextMistake);
$("variation-exit").addEventListener("click", () => {
  state.variation = null;
  render();
});

function navigate(action: string) {
  if (!state.review) return;
  const last = state.review.positions.length - 1;
  if (state.variation) state.variation = null;
  if (action === "start") goTo(0);
  else if (action === "prev") goTo(state.index - 1);
  else if (action === "next") goTo(state.index + 1);
  else if (action === "end") goTo(last);
}

function nextMistake() {
  const moves = state.review?.moves ?? [];
  const after = moves.find((m) => m.ply.index + 1 > state.index && m.ply.color === state.color && SEVERITY[m.classification] >= 1);
  const wrap = moves.find((m) => m.ply.color === state.color && SEVERITY[m.classification] >= 1);
  const target = after ?? wrap;
  if (target) goTo(target.ply.index + 1);
}

document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (!state.review || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const map: Record<string, () => void> = {
    ArrowLeft: () => navigate("prev"),
    ArrowRight: () => navigate("next"),
    Home: () => navigate("start"),
    End: () => navigate("end"),
    f: () => board?.toggleOrientation(),
    n: nextMistake,
  };
  const fn = map[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// ---------- Claude review ----------
const claudeBtn = $<HTMLButtonElement>("claude-go");
claudeBtn.addEventListener("click", async () => {
  if (state.claudeAbort) {
    state.claudeAbort.abort();
    return;
  }
  const key = apiKeyInput.value.trim();
  const errEl = $("claude-error");
  const out = $("claude-output");
  const warn = $("claude-warning");
  show(errEl, false);
  show(warn, false);
  if (!state.review || !state.coaching) return;
  if (!key) {
    errEl.textContent = "Enter an Anthropic API key to use this (the engine analysis above works without one).";
    show(errEl);
    return;
  }
  if (rememberKey.checked) store.set("api-key", key);
  const ctrl = new AbortController();
  state.claudeAbort = ctrl;
  claudeBtn.textContent = "Stop";
  let text = "";
  out.innerHTML = `<p class="muted">Claude is reading the engine analysis…</p>`;
  try {
    text = await writeCoachingReport(key, state.review, state.coaching, {
      signal: ctrl.signal,
      onText: (delta) => {
        text += delta;
        out.innerHTML = renderMarkdown(text);
      },
    });
    out.innerHTML = renderMarkdown(text);
  } catch (err) {
    errEl.textContent = describeApiError(err);
    show(errEl);
  } finally {
    state.claudeAbort = null;
    claudeBtn.textContent = "Write review";
  }
  const unverified = unverifiedMoves(text, state.review);
  if (unverified.length) {
    warn.innerHTML = `<strong>Not engine-verified:</strong> the review mentions ${unverified
      .map((m) => `<code>${escapeHtml(m)}</code>`)
      .join(", ")}, which ${unverified.length > 1 ? "don't" : "doesn't"} appear in any engine line or in the game. Treat ${
      unverified.length > 1 ? "those" : "that"
    } with caution — use “Verify deeper” on the board to check.`;
    show(warn);
  }
});
