import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { explainPosition, evalWords, moveIdea, templateLines, acceptPhrasing } from "@/lib/gist";
import { ollamaAvailability, ollamaModelPresent, DEFAULT_OLLAMA_MODEL } from "@/lib/llm";
import { speakSan, speakChessText } from "@/lib/speak-san";
import { START_FEN } from "@/lib/fen";
import type { LlmProvider } from "@/lib/llm";
import type { EngineResult } from "@/lib/types";

function engine(partial: Partial<EngineResult>): EngineResult {
  return {
    available: true,
    terminal: null,
    winner: null,
    bestMove: "g1f3",
    bestMoveSan: "Nf3",
    ponder: null,
    depth: 24,
    seldepth: null,
    score: { kind: "cp", value: 42 },
    scoreWhiteLabel: "+0.42 from White's side",
    pv: ["g1f3"],
    pvSan: ["Nf3"],
    pvLegal: true,
    nodes: 1000,
    nps: null,
    timeMs: null,
    stable: true,
    engineName: "Lichess cloud eval",
    whitePov: true,
    preference: { status: "provisional", reason: "One cached line." },
    coverage: "evaluated",
    ...partial,
  };
}

const offline: LlmProvider = {
  id: "none",
  async available() {
    return { ok: false, reason: "model off for this test" };
  },
  async complete() {
    throw new Error("no model");
  },
};

describe("explain gist", () => {
  it("speaks Nf3 as knight f3", () => {
    expect(speakSan("Nf3")).toBe("knight f3");
    expect(speakSan("Qxe5+")).toBe("queen takes e5 check");
    expect(speakSan("O-O")).toBe("castles kingside");
    expect(speakChessText("Best move: Nf3 develops.")).toBe("Best move: knight f3 develops.");
  });

  it("turns a stored eval into words without inventing a side", () => {
    expect(evalWords({ kind: "cp", value: 42 })).toBe("White is a bit better");
    expect(evalWords({ kind: "cp", value: -150 })).toBe("Black is better");
    expect(evalWords({ kind: "cp", value: -200 })).toBe("Black is much better");
    expect(evalWords({ kind: "mate", value: -1 })).toBe("Black is winning: mate in 1");
    const start = new Chess(START_FEN);
    const lines = templateLines(start, engine({}), null, null);
    expect(lines.balance).toMatch(/White is a bit better/);
    expect(lines.balance).toMatch(/engine-checked/);
    expect(lines.bestMove).toMatch(/^Nf3 develops and eyes [de][45]/);
  });

  it("stays provisional on a cloud miss and reuses the opening guide", async () => {
    const chess = new Chess();
    chess.move("e4");
    chess.move("c5");
    const gist = await explainPosition(
      { fen: chess.fen(), historySans: ["e4", "c5"] },
      {
        provider: offline,
        analyze: async () =>
          engine({
            coverage: "not-in-cloud",
            bestMove: null,
            bestMoveSan: null,
            score: null,
            scoreWhiteLabel: "No stored cloud evaluation",
            pv: [],
            pvSan: [],
          }),
      },
    );
    expect(gist.source).toBe("provisional");
    expect(gist.phrasing).toBe("facts-only");
    expect(gist.modelNote).toMatch(/model off/);
    expect(gist.balance.toLowerCase()).toMatch(/provisional/);
    expect(gist.balance).not.toMatch(/engine-checked/);
    expect(gist.whitePlan).toMatch(/Curated opening note/);
    expect(gist.whitePlan.toLowerCase()).toMatch(/sicilian|d4|c-file|pawn/);
    expect(gist.bestMove).toMatch(/No stored best move/);
    expect(gist.spoken).not.toMatch(/\bNf3\b/);
  });

  it("says the engine is cooling down instead of inventing an eval", async () => {
    const gist = await explainPosition(
      { fen: START_FEN },
      {
        provider: offline,
        analyze: async () =>
          engine({
            coverage: "cooling-down",
            bestMove: null,
            bestMoveSan: null,
            score: null,
            scoreWhiteLabel: "The engine is cooling down",
            pv: [],
            pvSan: [],
          }),
      },
    );
    expect(gist.source).toBe("provisional");
    expect(gist.balance.toLowerCase()).toMatch(/cooling down/);
    expect(gist.text).not.toMatch(/\+\d/);
  });

  it("names a hanging piece from the board and keeps an invented model eval out", async () => {
    const fen = "k7/8/8/8/8/8/q7/K6R w - - 0 1";
    const chess = new Chess(fen);
    expect(chess.moves()).toContain("Kxa2");
    const lines = templateLines(chess, engine({ bestMoveSan: "Kxa2", bestMove: "a1a2", pv: ["a1a2"], pvSan: ["Kxa2"] }), null, null);
    expect(lines.watch.toLowerCase()).toMatch(/queen on a2/);
    expect(moveIdea(fen, "Kxa2")).toMatch(/captures the queen/);
    const accepted = acceptPhrasing(
      lines,
      {
        balance: "Black is crushed +9.99 (engine-checked).",
        whitePlan: lines.whitePlan,
        blackPlan: lines.blackPlan,
        watch: lines.watch,
        bestMove: "Qh5 is the move to play.",
      },
      "engine-checked",
    );
    expect(accepted.balance).toBe(lines.balance);
    expect(accepted.balance).not.toMatch(/9\.99/);
    expect(accepted.bestMove).toBe(lines.bestMove);
    expect(accepted.bestMove).toMatch(/Kxa2/);
  });

  it("uses a model phrasing only when it stays inside the facts", async () => {
    const provider: LlmProvider = {
      id: "mock",
      async available() {
        return { ok: true };
      },
      async complete(messages) {
        const payload = messages.map((message) => message.content).join("\n");
        expect(payload).toContain("Nf3");
        expect(payload).not.toMatch(/student|question/i);
        return JSON.stringify({
          balance: "White is a bit better (engine-checked, +0.42 from White's side). The piece count is level.",
          whitePlan: "Develop and castle.",
          blackPlan: "Develop and castle.",
          watch: "No hanging piece showed up on a simple count.",
          bestMove: "Nf3 develops and eyes the center (engine-checked).",
        });
      },
    };
    const gist = await explainPosition(
      { fen: START_FEN },
      { provider, analyze: async () => engine({}) },
    );
    expect(gist.phrasing).toBe("model");
    expect(gist.source).toBe("engine-checked");
    expect(gist.bestMove).toMatch(/Nf3/);
    expect(gist.spoken).toMatch(/knight f3/);
    expect(gist.balance).not.toMatch(/crushed|Black is winning/);
  });

  it("requires the configured Ollama tag to be listed", () => {
    expect(DEFAULT_OLLAMA_MODEL).toBe("qwen2.5:14b");
    expect(ollamaModelPresent(["qwen2.5:14b"], "qwen2.5:14b")).toBe(true);
    expect(ollamaModelPresent(["qwen2.5:0.5b"], "qwen2.5:14b")).toBe(false);
    expect(ollamaModelPresent(["qwen2.5:14b-instruct"], "qwen2.5:14b")).toBe(false);
    const missing = ollamaAvailability({
      reachable: true,
      names: ["qwen2.5:0.5b"],
      model: "qwen2.5:14b",
      host: "127.0.0.1:11434",
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/not in \/api\/tags/);
    expect(missing.reason).toMatch(/facts-only/);
  });
});
