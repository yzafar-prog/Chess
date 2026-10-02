import { describe, expect, it } from "vitest";
import { parseInfoLine } from "../src/engine/uci.ts";
import { formatLine, parseGame, splitPgn, uciLineToSan } from "../src/analysis/pgn.ts";
import { classify, material, materialSwing, phaseOf } from "../src/analysis/review.ts";
import { formatScore, fromUci, moveAccuracy, winPercent } from "../src/analysis/score.ts";
import { detectColor } from "../src/analysis/insights.ts";
import { LEGAL_MATE, SCHOLAR, WITH_CLOCKS } from "./fixtures.ts";

describe("UCI parsing", () => {
  it("parses multipv info lines", () => {
    const l = parseInfoLine(
      "info depth 16 seldepth 26 multipv 2 score cp -43 nodes 308256 nps 1 hashfull 109 time 638 pv g8f6 d2d4 e5d4",
    );
    expect(l).toEqual({ multipv: 2, depth: 16, score: { cp: -43 }, pv: ["g8f6", "d2d4", "e5d4"] });
  });
  it("ignores bound scores and lines without a pv", () => {
    expect(parseInfoLine("info depth 10 multipv 1 score cp 20 lowerbound nodes 5 pv e2e4")).toBeNull();
    expect(parseInfoLine("info depth 10 currmove e2e4 currmovenumber 1")).toBeNull();
  });
  it("parses mate scores", () => {
    expect(parseInfoLine("info depth 5 multipv 1 score mate -2 pv a1a2")?.score).toEqual({ mate: -2 });
  });
});

describe("scores", () => {
  it("converts side-to-move scores to White's point of view", () => {
    expect(fromUci({ cp: 50 }, "b")).toEqual({ cp: -50 });
    expect(fromUci({ mate: 3 }, "b")).toEqual({ mate: 3, winner: "b" });
    expect(fromUci({ mate: -3 }, "b")).toEqual({ mate: 3, winner: "w" });
  });
  it("maps evaluations to win percentages", () => {
    expect(winPercent({ cp: 0 })).toBeCloseTo(50);
    expect(winPercent({ cp: 300 })).toBeCloseTo(75.1, 0);
    expect(winPercent({ mate: 2, winner: "b" })).toBe(0);
  });
  it("formats", () => {
    expect(formatScore({ cp: 123 })).toBe("+1.23");
    expect(formatScore({ mate: 4, winner: "b" })).toBe("-M4");
  });
  it("gives 100% accuracy to a perfect move and low accuracy to a blunder", () => {
    expect(moveAccuracy(0)).toBe(100);
    expect(moveAccuracy(40)).toBeLessThan(20);
  });
});

describe("PGN", () => {
  it("parses moves, FENs and UCI", () => {
    const g = parseGame(LEGAL_MATE);
    expect(g.plies).toHaveLength(13);
    expect(g.fens).toHaveLength(14);
    expect(g.plies[0]).toMatchObject({ san: "e4", uci: "e2e4", color: "w", moveNumber: 1 });
    expect(g.plies[9]).toMatchObject({ san: "Bxd1", color: "b", moveNumber: 5 });
    expect(g.headers.White).toBe("Alice");
  });
  it("reads clock comments", () => {
    const g = parseGame(WITH_CLOCKS);
    expect(g.plies[2].clockSeconds).toBe(20);
  });
  it("splits multi-game files", () => {
    expect(splitPgn(LEGAL_MATE + "\n\n" + SCHOLAR)).toHaveLength(2);
  });
  it("rejects garbage", () => {
    expect(() => parseGame("1. e4 e5 2. Ke3 Kxe4 nonsense")).toThrow();
  });
  it("renders engine lines in SAN with move numbers", () => {
    const fen = parseGame(SCHOLAR).fens[1]; // after 1. e4, Black to move
    const san = uciLineToSan(fen, ["e7e5", "g1f3", "b8c6"]);
    expect(san).toEqual(["e5", "Nf3", "Nc6"]);
    expect(formatLine(fen, san)).toBe("1... e5 2. Nf3 Nc6");
  });
});

describe("classification helpers", () => {
  it("uses lichess thresholds", () => {
    expect(classify(0, true)).toBe("best");
    expect(classify(3, false)).toBe("good");
    expect(classify(7, false)).toBe("inaccuracy");
    expect(classify(12, false)).toBe("mistake");
    expect(classify(30, false)).toBe("blunder");
  });
  it("counts material and detects phases", () => {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(material(start)).toBe(0);
    expect(phaseOf(start, 1)).toBe("opening");
    expect(phaseOf("8/5k2/8/8/8/8/2R2K2/8 w - - 0 50", 50)).toBe("endgame");
  });
  it("measures material won along a line without stopping mid-exchange", () => {
    // White queen takes an undefended rook.
    const fen = "4k3/8/8/8/8/8/r7/Q3K3 w - - 0 1";
    expect(materialSwing(fen, ["a1a2"], "w")).toBe(5);
  });
  it("detects which side the user played", () => {
    expect(detectColor({ White: "Alice", Black: "bob99" }, "BOB99")).toBe("b");
    expect(detectColor({ White: "Alice", Black: "Bob" }, "zed")).toBeNull();
  });
});

describe("markdown rendering", async () => {
  const { renderMarkdown } = await import("../src/ui/markdown.ts");
  it("escapes HTML from model output", () => {
    expect(renderMarkdown("## Hi\n<script>x</script> **bold**")).toBe(
      "<h3>Hi</h3>\n<p>&lt;script&gt;x&lt;/script&gt; <strong>bold</strong></p>",
    );
  });
});
