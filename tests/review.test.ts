import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { handleApi } from "@/lib/http/router";
import { setCloudFetchForTests } from "@/lib/lichess-cloud";
import { fetchRecentLichessGames } from "@/lib/lichess-games";
import { reviewGame } from "@/lib/review";
import { START_FEN } from "@/lib/fen";

function fenAfter(sans: string[]): string[] {
  const chess = new Chess(START_FEN);
  const fens = [chess.fen()];
  for (const san of sans) {
    chess.move(san);
    fens.push(chess.fen());
  }
  return fens;
}

describe("game review", () => {
  it("flags a queen loss as heuristic when the cloud has no line", async () => {
    setCloudFetchForTests(async () => ({ status: 404, body: JSON.stringify({ error: "no" }) }));
    const review = await reviewGame({
      sans: ["e4", "e5", "Qh5", "Nc6", "Qxe5", "Nxe5"],
    });
    expect(review.openingGuide?.id).toBe("wayward-queen");
    expect(review.openingGuide?.label).toMatch(/Curated/);
    const moment = review.moments.find((item) => item.san === "Qxe5");
    expect(moment?.source).toBe("heuristic");
    expect(moment?.label).toBe("Lost material");
    expect(review.cloudHits).toBe(0);
    expect(review.cloudMisses).toBeGreaterThan(0);
    expect(review.recommendations.length).toBeGreaterThanOrEqual(2);
    expect(review.recommendations.length).toBeLessThanOrEqual(3);
    expect(review.recommendations.join(" ")).toMatch(/Curated|curated/);
    expect(review.summary).toMatch(/heuristic/i);
  });

  it("reports an engine-verified swing when both positions are cached", async () => {
    const sans = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];
    const fens = fenAfter(sans);
    const scores = new Map<string, number>();
    fens.forEach((fen, index) => scores.set(fen, index === 5 ? -250 : 20));
    setCloudFetchForTests(async (url) => {
      const fen = new URL(url).searchParams.get("fen") ?? "";
      const chess = new Chess(fen);
      const move = chess.moves({ verbose: true })[0];
      const uci = move ? `${move.from}${move.to}${move.promotion ?? ""}` : "e2e4";
      return {
        status: 200,
        body: JSON.stringify({ fen, knodes: 8, depth: 30, pvs: [{ moves: uci, cp: scores.get(fen) ?? 20 }] }),
      };
    });
    const review = await reviewGame({ sans, player: "white" });
    expect(review.openingGuide?.id).toBe("ruy");
    const swing = review.moments.find((item) => item.source === "engine" && item.san === "Bb5");
    expect(swing?.label).toMatch(/Mistake|Blunder/);
    expect(swing?.note).toMatch(/Engine-verified/);
    expect(review.recommendations.some((item) => item.startsWith("Your Bb5"))).toBe(true);
    expect(review.recommendations.length).toBeGreaterThanOrEqual(2);
  });

  it("does not call a recaptured opening pawn a slip", async () => {
    setCloudFetchForTests(async () => ({ status: 404, body: "{}" }));
    const sicilian = await reviewGame({
      sans: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"],
    });
    expect(sicilian.openingGuide?.id).toBe("najdorf");
    expect(sicilian.moments.find((item) => item.san === "d4")).toBeUndefined();
    const gambit = await reviewGame({ sans: ["e4", "e5", "f4", "exf4", "Nf3"] });
    expect(gambit.moments.find((item) => item.san === "f4")?.label).toBe("Possible pawn slip");
  });

  it("stops when the engine is cooling down", async () => {
    setCloudFetchForTests(async () => ({ status: 429, body: "" }));
    const review = await reviewGame({ sans: ["e4", "e5", "Nf3", "Nc6"] });
    expect(review.coolingDown).toBe(true);
    expect(review.summary.toLowerCase()).toMatch(/cooling down/);
    expect(review.recommendations.length).toBeGreaterThanOrEqual(2);
  });

  it("reads a public Lichess game list and rejects a bad username", async () => {
    await expect(fetchRecentLichessGames("../etc")).rejects.toThrow(/username/i);
    setCloudFetchForTests(async (url, init) => {
      expect(url).toContain("/api/games/user/test_user?max=10");
      expect(init.headers.accept).toBe("application/x-ndjson");
      const game = {
        id: "abcdefgh",
        variant: "standard",
        speed: "rapid",
        winner: "black",
        moves: "e4 c5 Nf3 d6",
        opening: { name: "Sicilian Defense" },
        players: { white: { user: { name: "test_user" } }, black: { user: { name: "Other" } } },
      };
      const other = { id: "crazy", variant: "crazyhouse", moves: "e4 e5", players: {} };
      return { status: 200, body: `${JSON.stringify(game)}\n${JSON.stringify(other)}\n` };
    });
    const games = await fetchRecentLichessGames("test_user");
    expect(games).toHaveLength(1);
    expect(games[0].opening).toBe("Sicilian Defense");
    expect(games[0].result).toBe("0-1");
    expect(games[0].pgn).toContain("e4 c5 Nf3 d6");
    const origin = "http://127.0.0.1:43123";
    const denied = await handleApi(
      new Request(`${origin}/api/lichess/games?username=a/b`, { headers: { origin } }),
    );
    expect(denied.status).toBe(400);
  });
});
