import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { importPosition } from "@/lib/import-position";
import { START_FEN } from "@/lib/fen";
import { CLOSED_CENTER_FEN } from "@/lib/samples";
import { catalogFullmove, loadOpeningIndex, openingClaim, preferDeeper, recognizeOpening } from "@/lib/openings";
import { runCoachTurn } from "@/lib/coach";
import type { LlmProvider } from "@/lib/llm";

const none: LlmProvider = {
  id: "none",
  async available() {
    return { ok: false, reason: "model off for this test" };
  },
  async complete() {
    throw new Error("no model");
  },
};

function play(sans: string[], start = START_FEN): string {
  const chess = new Chess(start);
  for (const san of sans) chess.move(san);
  return chess.fen();
}

describe("opening catalog", () => {
  it("reports the inspected Lichess snapshot and real family names", () => {
    const index = loadOpeningIndex();
    expect(index.source.commit).toBe("3ba6b20d31b2e6125cb0e6a2e792f400717d9d39");
    expect(index.source.license).toBe("CC0-1.0");
    expect(index.rows).toBe(3865);
    expect(index.uniquePositions).toBe(3865);
    expect(index.ecoCount).toBe(500);
    expect(index.skipped).toBe(0);
    const italian = recognizeOpening({ fen: play(["e4", "e5", "Nf3", "Nc6", "Bc4"]) });
    const sicilian = recognizeOpening({ fen: play(["e4", "c5"]) });
    expect(italian?.names).toContain("Italian Game");
    expect(italian?.ecos).toContain("C50");
    expect(sicilian?.names).toContain("Sicilian Defense");
    expect(sicilian?.ecos).toContain("B20");
  });

  it("matches a transposition by position and keeps a deeper catalog line", () => {
    const transposed = recognizeOpening({
      fen: play(["e4", "e5", "Bc4", "Nc6", "Nf3"]),
      sans: ["e4", "e5", "Bc4", "Nc6", "Nf3"],
    });
    expect(transposed?.names).toContain("Italian Game");
    expect(transposed?.currentIsCatalogPosition).toBe(true);
    const deeper = preferDeeper(
      [{ eco: "C50", name: "Italian Game", pgn: "short", plies: 5 }],
      [{ eco: "C50", name: "Italian Game: Giuoco Piano", pgn: "long", plies: 7 }],
    );
    expect(deeper.map((hit) => hit.name)).toEqual(["Italian Game: Giuoco Piano"]);
    const sameDepth = preferDeeper(
      [{ eco: "C50", name: "Italian Game", pgn: "a", plies: 5 }],
      [{ eco: "C54", name: "Other Name", pgn: "b", plies: 5 }],
    );
    expect(sameDepth).toHaveLength(2);
  });

  it("does not treat a FEN fullmove counter as the catalog move number", () => {
    const reached = play(["e4", "e5", "Nf3", "Nc6", "Bc4"]);
    const parts = reached.split(" ");
    parts[5] = "40";
    const shifted = parts.join(" ");
    const fenOnly = recognizeOpening({ fen: shifted });
    expect(fenOnly?.historyUsed).toBe(false);
    expect(fenOnly?.names).toContain("Italian Game");
    expect(fenOnly?.catalogPlies).toBe(5);
    expect(fenOnly?.catalogFullmove).toBe(catalogFullmove(5));
    expect(fenOnly?.fenFullmove).toBe(40);
    expect(fenOnly?.catalogFullmove).not.toBe(40);
    const claim = openingClaim(fenOnly!);
    expect(claim.status).toBe("provisional");
    expect(claim.kind).toBe("catalog");
    expect(claim.text).toMatch(/does not establish/);
  });

  it("keeps a PGN prefix when the game leaves the catalog, and ignores an unknown setup", () => {
    const sans = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "a3"];
    const beyond = recognizeOpening({ fen: play(sans), sans });
    expect(beyond?.historyUsed).toBe(true);
    expect(beyond?.currentIsCatalogPosition).toBe(false);
    expect(beyond?.matchedAtPly).toBeLessThan(sans.length);
    expect(beyond?.names.join(" ")).toMatch(/Italian|Two Knights|Knight/);
    expect(beyond?.label).toMatch(/not the current catalog position/);
    expect(CLOSED_CENTER_FEN.startsWith("r1bq1rk1")).toBe(true);
    const setup = recognizeOpening({ fen: CLOSED_CENTER_FEN });
    expect(setup).toBeNull();
    expect(recognizeOpening({ fen: "not-a-fen" })).toBeNull();
    expect(() => importPosition("1. e4 e5 2. Nf5 *")).toThrow(/illegal|invalid move/i);
  });

  it("does not map the catalog name because a search likes the position", async () => {
    const sans = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
    const result = await runCoachTurn(
      { fen: play(sans), historySans: sans, question: "Is the Italian the right plan?", depth: 6, movetimeMs: 600 },
      { provider: none },
    );
    const catalog = result.claims.find((claim) => claim.kind === "catalog");
    expect(catalog?.status).toBe("provisional");
    expect(result.claims.find((claim) => claim.id === "search-report")?.status).toBe("mapped");
    expect(result.claims.filter((claim) => /Italian Game/.test(claim.text)).every((claim) => claim.status !== "mapped")).toBe(true);
    expect(result.opening?.status).toBe("provisional");
  });
});
