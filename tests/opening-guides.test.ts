import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { runCoachTurn } from "@/lib/coach";
import { START_FEN } from "@/lib/fen";
import type { LlmProvider } from "@/lib/llm";
import { guideForNames, guideForOpening, OPENING_GUIDES } from "@/lib/opening-guides";
import { loadOpeningIndex, recognizeOpening } from "@/lib/openings";

const none: LlmProvider = {
  id: "none",
  async available() {
    return { ok: false, reason: "model off" };
  },
  async complete() {
    throw new Error("no model");
  },
};

function play(sans: string[]): string {
  const chess = new Chess(START_FEN);
  for (const san of sans) chess.move(san);
  return chess.fen();
}

describe("opening guides", () => {
  it("maps every curated needle onto the bundled catalog", () => {
    const names = new Set<string>();
    for (const entry of Object.values(loadOpeningIndex().positions)) {
      for (const hit of entry.hits) names.add(hit.name);
    }
    const all = [...names];
    for (const guide of OPENING_GUIDES) {
      const matched = guide.needles.some((needle) => all.some((name) => name.includes(needle)));
      expect(matched, guide.id).toBe(true);
    }
  });

  it("prefers the specific line over the family", () => {
    expect(guideForNames(["Sicilian Defense"])?.id).toBe("sicilian");
    expect(guideForNames(["Sicilian Defense: Najdorf Variation, Scheveningen Variation"])?.id).toBe("najdorf");
    expect(guideForNames(["Sicilian Defense: Accelerated Dragon"])?.id).toBe("accelerated-dragon");
    expect(guideForNames(["Semi-Slav Defense: Meran Variation"])?.id).toBe("semi-slav");
    expect(guideForNames(["Ruy Lopez: Berlin Defense, Winawer Attack"])?.id).toBe("ruy-berlin");
    expect(guideForNames(["French Defense: Winawer Variation, Alekhine Gambit"])?.id).toBe("french-winawer");
    expect(guideForNames(["Caro-Kann Defense: Panov Attack, Modern Defense"])?.id).toBe("caro-panov");
    expect(guideForNames(["King's Indian Defense: Averbakh Variation, Benoni Defense"])?.id).toBe("kings-indian");
  });

  it("attaches guides to real catalog positions", () => {
    const cases: Array<[string[], string]> = [
      [["e4", "c5"], "sicilian"],
      [["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"], "najdorf"],
      [["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "g6"], "dragon"],
      [["e4", "e5", "Nf3", "Nc6", "Bb5"], "ruy"],
      [["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6"], "ruy-berlin"],
      [["e4", "e5", "Nf3", "Nc6", "Bc4"], "italian"],
      [["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], "giuoco"],
      [["e4", "e6"], "french"],
      [["e4", "c6"], "caro"],
      [["d4", "d5", "c4"], "queens-gambit"],
      [["d4", "d5", "c4", "e6"], "qgd"],
      [["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6"], "kings-indian"],
      [["d4", "d5", "Nf3", "Nf6", "Bf4"], "london"],
      [["c4"], "english"],
      [["e4", "d5"], "scandinavian"],
    ];
    for (const [sans, id] of cases) {
      const opening = recognizeOpening({ fen: play(sans), sans });
      expect(guideForOpening(opening)?.id, sans.join(" ")).toBe(id);
      expect(guideForOpening(opening)?.label).toMatch(/Curated, not engine-verified/);
    }
    expect(guideForOpening(null)).toBeNull();
  });

  it("lets the coach use the guide when asked about a plan, still provisional", async () => {
    const sans = ["e4", "c5"];
    const result = await runCoachTurn(
      { fen: play(sans), historySans: sans, question: "What is the plan for both sides?" },
      { provider: none },
    );
    expect(result.openingGuide?.id).toBe("sicilian");
    expect(result.reply).toMatch(/Curated opening note, not engine-verified/);
    const claim = result.claims.find((item) => item.id === "opening-guide");
    expect(claim?.status).toBe("provisional");
    expect(claim?.kind).toBe("strategic");
    expect(result.claims.filter((item) => /Sicilian/.test(item.text)).every((item) => item.status !== "mapped")).toBe(true);
  });
});
