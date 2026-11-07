import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { clearAssessmentCache, runCoachTurn } from "@/lib/coach";
import { activeEngineCount, analyzeFen } from "@/lib/engine";
import {
  CLOUD_COOLDOWN_MS,
  cloudCooldownRemainingMs,
  cloudScoreToWhite,
  clearCloudMemoryForTests,
  setCloudClockForTests,
  setCloudDiskForTests,
  setCloudFetchForTests,
  setCloudTimeoutForTests,
  type CloudFetcher,
} from "@/lib/lichess-cloud";
import type { LlmProvider } from "@/lib/llm";

const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const fools = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
const mateFen = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";

const none: LlmProvider = {
  id: "none",
  async available() {
    return { ok: false, reason: "model off" };
  },
  async complete() {
    throw new Error("no model");
  },
};

function json(body: unknown, status = 200) {
  return { status, body: JSON.stringify(body) };
}

describe("lichess cloud eval", () => {
  it("keeps a positive cp when Black is to move and converts the PV to SAN", async () => {
    let calls = 0;
    setCloudFetchForTests(async (url) => {
      calls += 1;
      const fen = new URL(url).searchParams.get("fen");
      expect(url).toContain("https://lichess.org/api/cloud-eval");
      expect(url).toContain("multiPv=5");
      expect(fen).toBe(afterE4);
      return json({
        fen: afterE4,
        knodes: 20,
        depth: 40,
        pvs: [{ moves: "e7e5 g1f3", cp: 18 }],
      });
    });
    const result = await analyzeFen(afterE4);
    expect(calls).toBe(1);
    expect(result.whitePov).toBe(true);
    expect(result.score).toEqual({ kind: "cp", value: 18 });
    expect(result.bestMove).toBe("e7e5");
    expect(result.bestMoveSan).toBe("e5");
    expect(result.pvSan).toEqual(["e5", "Nf3"]);
    expect(result.pvLegal).toBe(true);
    expect(result.depth).toBe(40);
    expect(result.stable).toBe(true);
    expect(result.coverage).toBe("evaluated");
    expect(result.engineName).toBe("Lichess cloud eval");
    expect(result.preference.status).toBe("provisional");
    expect(activeEngineCount()).toBe(0);
    const again = await analyzeFen(afterE4);
    expect(again.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not flip mate when Black is mating", async () => {
    setCloudFetchForTests(async () => json({ fen: fools, knodes: 1, depth: 30, pvs: [{ moves: "d8h4", mate: -1 }] }));
    const result = await analyzeFen(fools);
    expect(cloudScoreToWhite({ mate: -1 })).toEqual({ kind: "mate", value: -1 });
    expect(result.score).toEqual({ kind: "mate", value: -1 });
    expect(result.bestMoveSan).toBe("Qh4#");
    expect(result.pvLegal).toBe(true);
  });

  it("matches a search move in the cloud lines and does not negate a child eval", async () => {
    let calls = 0;
    setCloudFetchForTests(async (url) => {
      calls += 1;
      const fen = new URL(url).searchParams.get("fen") ?? "";
      if (fen === start) {
        return json({ fen, knodes: 4, depth: 22, pvs: [{ moves: "d2d4 d7d5", cp: 15 }] });
      }
      const chess = new Chess(fen);
      expect(chess.turn()).toBe("b");
      return json({ fen, knodes: 4, depth: 21, pvs: [{ moves: "e7e5", cp: 30 }] });
    });
    const played = await analyzeFen(start, { depth: 12, movetimeMs: 500 }, undefined, ["e2e4"]);
    expect(calls).toBe(2);
    expect(played.bestMove).toBe("e2e4");
    expect(played.bestMoveSan).toBe("e4");
    expect(played.score?.value).toBe(30);
    expect(played.pvSan[0]).toBe("e4");
    expect(played.pvSan[1]).toBe("e5");
    expect(played.searchedMove).toBe("e2e4");

    clearCloudMemoryForTests();
    let matchedCalls = 0;
    setCloudFetchForTests(async () => {
      matchedCalls += 1;
      return json({ fen: start, knodes: 4, depth: 22, pvs: [{ moves: "e2e4 e7e5", cp: 19 }, { moves: "d2d4", cp: 12 }] });
    });
    const matched = await analyzeFen(start, undefined, undefined, ["e2e4"]);
    expect(matched.score?.value).toBe(19);
    expect(matched.bestMoveSan).toBe("e4");
    expect(matched.pvSan.slice(0, 2)).toEqual(["e4", "e5"]);
    expect(matchedCalls).toBe(1);
  });

  it("treats 404 as a provisional miss and does not throw", async () => {
    setCloudFetchForTests(async () => ({ status: 404, body: JSON.stringify({ error: "No cloud evaluation available" }) }));
    const missed = await analyzeFen(start);
    expect(missed.coverage).toBe("not-in-cloud");
    expect(missed.bestMove).toBeNull();
    expect(missed.score).toBeNull();
    const again = await analyzeFen(start);
    expect(again.fromCache).toBe(true);
    clearAssessmentCache();
    const coach = await runCoachTurn({ fen: start, question: "What is the plan here?" }, { provider: none });
    expect(coach.engineError).toBeUndefined();
    expect(coach.claims.find((claim) => claim.id === "engine-unverified")?.status).toBe("provisional");
    expect(coach.reply.toLowerCase()).toMatch(/provisional/);
    expect(coach.reply.toLowerCase()).toMatch(/nearby|earlier/);
  });

  it("backs off for 60 seconds after 429 and says the engine is cooling down", async () => {
    let now = 1_000_000;
    let calls = 0;
    setCloudClockForTests(() => now);
    setCloudFetchForTests(async () => {
      calls += 1;
      return { status: 429, body: "too many" };
    });
    const first = await analyzeFen(start);
    expect(first.coverage).toBe("cooling-down");
    expect(first.scoreWhiteLabel.toLowerCase()).toMatch(/cooling down/);
    expect(cloudCooldownRemainingMs()).toBe(CLOUD_COOLDOWN_MS);
    const second = await analyzeFen(afterE4);
    expect(second.coverage).toBe("cooling-down");
    expect(calls).toBe(1);
    now += 59_000;
    const still = await analyzeFen(start);
    expect(still.coverage).toBe("cooling-down");
    expect(calls).toBe(1);
    now += 1_000;
    setCloudFetchForTests(async () => json({ fen: start, knodes: 1, depth: 20, pvs: [{ moves: "e2e4", cp: 12 }] }));
    const resumed = await analyzeFen(start);
    expect(resumed.coverage).toBe("evaluated");
    expect(resumed.bestMoveSan).toBe("e4");
  });

  it("cancels an in-flight lookup", async () => {
    const fetcher: CloudFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    setCloudFetchForTests(fetcher);
    const controller = new AbortController();
    const pending = analyzeFen(start, { depth: 12, movetimeMs: 500 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(activeEngineCount()).toBe(0);
  });

  it("reports a timeout without throwing", async () => {
    setCloudTimeoutForTests(20);
    setCloudFetchForTests(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const result = await analyzeFen(start);
    expect(result.coverage).toBe("timeout");
    expect(result.preference.status).toBe("open");
  });

  it("does not call the network for a finished game or an illegal FEN", async () => {
    let calls = 0;
    setCloudFetchForTests(async () => {
      calls += 1;
      return { status: 500, body: "" };
    });
    const over = await analyzeFen(mateFen);
    expect(over.terminal).toBe("checkmate");
    expect(over.winner).toBe("white");
    expect(over.bestMove).toBeNull();
    await expect(analyzeFen("8/8/8/8/8/8/8/8 w - - 0 1")).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("reads a repeated position from the on-disk cache", async () => {
    const previous = process.env.DATA_DIR;
    const dir = mkdtempSync(path.join(tmpdir(), "talkfish-cloud-"));
    process.env.DATA_DIR = dir;
    setCloudDiskForTests(true);
    let calls = 0;
    setCloudFetchForTests(async () => {
      calls += 1;
      return json({ fen: start, knodes: 3, depth: 18, pvs: [{ moves: "e2e4", cp: 20 }] });
    });
    await analyzeFen(start);
    expect(calls).toBe(1);
    const saved = JSON.parse(readFileSync(path.join(dir, "lichess-cloud.json"), "utf8")) as { entries: unknown[] };
    expect(saved.entries.length).toBeGreaterThan(0);
    clearCloudMemoryForTests();
    const cached = await analyzeFen(start);
    expect(cached.fromCache).toBe(true);
    expect(cached.bestMoveSan).toBe("e4");
    expect(calls).toBe(1);
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  });
});
