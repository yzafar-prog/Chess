// Integration tests against the real Stockfish 19 WASM engine.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzePositions } from "../src/analysis/analyze.ts";
import { buildCoaching } from "../src/analysis/insights.ts";
import { parseGame } from "../src/analysis/pgn.ts";
import { reviewGame } from "../src/analysis/review.ts";
import { createNodeEngine } from "../src/engine/node.ts";
import type { UciEngine } from "../src/engine/uci.ts";
import { buildFacts, unverifiedMoves } from "../src/coach/claude.ts";
import { LEGAL_MATE, SCHOLAR } from "./fixtures.ts";

let engine: UciEngine;
beforeAll(async () => {
  engine = await createNodeEngine();
});
afterAll(() => engine?.quit());

const settings = { depth: 12, multipv: 3 };

describe("engine-verified review", () => {
  it("finds the mate in one and flags the blunder that allowed it", async () => {
    const game = parseGame(SCHOLAR);
    const review = reviewGame(game, await analyzePositions(engine, game.fens, settings));
    const final = review.moves[6]; // 4. Qxf7#
    expect(final.ply.san).toBe("Qxf7#");
    expect(final.isBest).toBe(true);
    expect(review.positions[7].terminal).toBe("checkmate");
    const nf6 = review.moves[5]; // 3... Nf6??
    expect(nf6.classification).toBe("blunder");
    expect(nf6.tags).toContain("allowed-mate");
    expect(nf6.refutation?.san[0]).toBe("Qxf7#");
  });

  it("reviews Legal's mate: Bxd1 is a blunder into mate, engine prefers dxe5", async () => {
    const game = parseGame(LEGAL_MATE);
    const positions = await analyzePositions(engine, game.fens, settings);
    const review = reviewGame(game, positions);
    const bxd1 = review.moves[9];
    expect(bxd1.ply.san).toBe("Bxd1");
    expect(bxd1.classification).toBe("blunder");
    expect(bxd1.tags).toContain("allowed-mate");
    expect(bxd1.bestLine.san[0]).toBe("dxe5");
    expect(review.moves[12].ply.san).toBe("Nd5#");
    expect(review.moves[12].isBest).toBe(true);

    const coaching = buildCoaching(review, "b");
    expect(coaching.player).toBe("Bob");
    expect(coaching.keyMoments.map((m) => m.ply.san)).toContain("Bxd1");
    expect(coaching.turningPoint?.ply.san).toBe("Bxd1");
    expect(coaching.recommendations.map((r) => r.id).slice(0, 2)).toEqual(["turning-point", "allowed-mate"]);
    expect(review.summary.w.accuracy!).toBeGreaterThan(review.summary.b.accuracy!);

    // Claude guard rails: facts carry the engine lines; invented moves get flagged.
    const facts = buildFacts(review, coaching);
    expect(facts.key_moments.find((m) => m.move === "5... Bxd1")?.engine_best_move).toBe("dxe5");
    expect(unverifiedMoves("After 5... Bxd1 6. Bxf7+ Ke7 7. Nd5# it is over; 5... Qh4 was also bad.", review)).toEqual(["Qh4"]);
  });

  it("reports progress and can be cancelled", async () => {
    const game = parseGame(LEGAL_MATE);
    const ctrl = new AbortController();
    const seen: number[] = [];
    const run = analyzePositions(engine, game.fens, { depth: 14, multipv: 1 }, {
      signal: ctrl.signal,
      onProgress: (done) => {
        seen.push(done);
        if (done === 3) ctrl.abort();
      },
    });
    await expect(run).rejects.toThrow(/cancelled/);
    expect(seen).toEqual([1, 2, 3]);
  });
});
