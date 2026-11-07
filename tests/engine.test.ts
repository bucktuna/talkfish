import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { activeEngineCount, analyzeFen } from "@/lib/engine";

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const limits = { depth: 8, movetimeMs: 1500 };

describe("stockfish", () => {
  it("returns a legal PV and a White-point-of-view score", async () => {
    const white = await analyzeFen(start, limits);
    expect(white.engineName.toLowerCase()).toContain("stockfish");
    expect(white.pvLegal).toBe(true);
    expect(white.bestMoveSan).toBeTruthy();
    const chess = new Chess(start);
    expect(chess.moves()).toContain(white.bestMoveSan!);
    const blackToMove = await analyzeFen("6k1/8/8/8/8/8/8/Q5K1 b - - 0 1", limits);
    expect(blackToMove.score?.value).toBeGreaterThan(0);
    expect(blackToMove.whitePov).toBe(true);
    expect(activeEngineCount()).toBe(0);
  });

  it("reports mate, terminal positions, and rejects an illegal FEN", async () => {
    const mate = await analyzeFen("7k/R7/6K1/8/8/8/8/8 w - - 0 1", limits);
    expect(mate.score?.kind).toBe("mate");
    expect(mate.score!.value).toBeGreaterThan(0);
    const over = await analyzeFen("r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4", limits);
    expect(over.terminal).toBe("checkmate");
    expect(over.winner).toBe("white");
    expect(over.bestMove).toBeNull();
    await expect(analyzeFen("8/8/8/8/8/8/8/8 w - - 0 1", limits)).rejects.toThrow();
    expect(activeEngineCount()).toBe(0);
  });

  it("kills the process when the search is cancelled", async () => {
    const controller = new AbortController();
    const pending = analyzeFen(start, { depth: 30, movetimeMs: 8000 }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(activeEngineCount()).toBe(0);
  });
});
