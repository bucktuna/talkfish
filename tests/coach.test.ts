import { beforeEach, describe, expect, it } from "vitest";
import { clearAssessmentCache, runCoachTurn } from "@/lib/coach";
import { CLOSED_CENTER_FEN, OPEN_GAME_FEN } from "@/lib/samples";
import type { LlmProvider } from "@/lib/llm";
import { OPEN_INVITATION } from "@/lib/types";

const limits = { depth: 6, movetimeMs: 800 };

function mockProvider(): LlmProvider & { calls: { purpose: string; content: string }[] } {
  const calls: { purpose: string; content: string }[] = [];
  return {
    id: "mock",
    calls,
    async available() {
      return { ok: true };
    },
    async complete(messages, call) {
      calls.push({ purpose: call.purpose, content: JSON.stringify(messages) });
      if (call.purpose === "assess") {
        return JSON.stringify({
          summary: "Independent reading: the position is unsettled.",
          hypotheses: [{ text: "A plan is not proved by one line.", whyProvisional: "search" }],
        });
      }
      return JSON.stringify({
        reply: "Yes, Re1 proves f4 is no longer a plan.",
        hypotheses: ["Maybe White is restraining the position."],
      });
    },
  };
}

describe("coach loop", () => {
  beforeEach(() => clearAssessmentCache());

  it("assesses before it reads the question, and does not show the question to that pass", async () => {
    const provider = mockProvider();
    const question = "ZZUNIQUE-USER-HYPOTHESIS does the rook retire f4?";
    const result = await runCoachTurn(
      { fen: CLOSED_CENTER_FEN, question, ...limits },
      { provider },
    );
    expect(provider.calls.map((call) => call.purpose)).toEqual(["assess", "examine"]);
    expect(provider.calls[0].content).not.toContain("ZZUNIQUE-USER-HYPOTHESIS");
    expect(provider.calls[1].content).toContain("ZZUNIQUE-USER-HYPOTHESIS");
    expect(result.sequencing.userQuestionVisibleToAssessment).toBe(false);
    expect(result.claims.some((claim) => claim.status === "mapped" && /proves f4 is no longer/.test(claim.text))).toBe(false);
    expect(result.claims.some((claim) => claim.id === "model-overclaim" && claim.status === "open")).toBe(true);
    expect(result.invitation).toBe(OPEN_INVITATION);
  });

  it("says engine-only when no model is available and keeps the f4 plan open", async () => {
    const provider: LlmProvider = {
      id: "none",
      async available() {
        return { ok: false, reason: "No local model responded." };
      },
      async complete() {
        throw new Error("should not be called");
      },
    };
    const result = await runCoachTurn(
      {
        fen: CLOSED_CENTER_FEN,
        question: "You put the rook on e1, so f4 is no longer a future plan, right?",
        ...limits,
      },
      { provider },
    );
    expect(result.mode).toBe("engine-only");
    expect(result.reply.toLowerCase()).toContain("engine-only");
    expect(result.reply.toLowerCase()).not.toContain("as a language model");
    expect(result.claims.find((claim) => claim.id === "f4-legal")?.status).toBe("mapped");
    expect(result.claims.find((claim) => claim.id === "f4-plan-open")?.status).toBe("open");
    expect(result.patternsApplied).toContain("rook-does-not-retire-break");
    const opening = await runCoachTurn(
      { fen: OPEN_GAME_FEN, question: "What is a sensible developing idea here?", ...limits },
      { provider },
    );
    expect(opening.patternsApplied).not.toContain("rook-does-not-retire-break");
  });
});
