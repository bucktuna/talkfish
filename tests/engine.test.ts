import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { activeEngineCount, analyzeFen, resolveStockfishPath, stockfishInstalled } from "@/lib/engine";

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const limits = { depth: 8, movetimeMs: 1500 };

function binaryAvailable(): boolean {
  try {
    return stockfishInstalled() || localWhich();
  } catch {
    return false;
  }
}

function localWhich(): boolean {
  const bin = resolveStockfishPath();
  if (existsSync(bin)) return true;
  if (bin.includes("/")) return false;
  const found = spawnSync("which", [bin], { encoding: "utf8" });
  return found.status === 0;
}

const available = binaryAvailable();

describe("stockfish", () => {
  beforeAll(() => {
    process.env.ENGINE_PROVIDER = "uci";
  });
  afterAll(() => {
    delete process.env.ENGINE_PROVIDER;
  });

  it.skipIf(!available)("returns a legal PV and a White-point-of-view score", async () => {
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

  it.skipIf(!available)("reports mate from a search", async () => {
    const mate = await analyzeFen("7k/R7/6K1/8/8/8/8/8 w - - 0 1", limits);
    expect(mate.score?.kind).toBe("mate");
    expect(mate.score!.value).toBeGreaterThan(0);
    expect(activeEngineCount()).toBe(0);
  });

  it.skipIf(!available)("kills the process when the search is cancelled", async () => {
    const controller = new AbortController();
    const pending = analyzeFen(start, { depth: 30, movetimeMs: 8000 }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(activeEngineCount()).toBe(0);
  });
});
