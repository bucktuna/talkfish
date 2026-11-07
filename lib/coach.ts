import { Chess } from "chess.js";
import { boardFacts } from "@/lib/board-facts";
import { findPosition, loadPackagedCorpus, matchingPatterns, type CorpusFile } from "@/lib/corpus";
import { analyzeFen, clampLimits, EngineError, type SearchLimits } from "@/lib/engine";
import { affirmsRookRetiresBreak, extractMoveRefs, questionFindings } from "@/lib/fallacies";
import { positionKeyFromFen } from "@/lib/fen";
import {
  buildAssessmentMessages,
  buildExamineMessages,
  getProvider,
  modelAssessmentFromText,
  modelReplyFromText,
  provisionalModelClaims,
  type LlmProvider,
} from "@/lib/llm";
import { asksAboutPlans, guideForOpening } from "@/lib/opening-guides";
import { openingClaim, recognizeOpening } from "@/lib/openings";
import { sessionHas, sessionRemember } from "@/lib/session-memory";
import type { Assessment, Claim, CoachResponse, ComparisonResult, EngineResult } from "@/lib/types";
import { OPEN_INVITATION } from "@/lib/types";

const assessmentCache = new Map<string, Assessment>();

export function clearAssessmentCache(): void {
  assessmentCache.clear();
}

export type CoachInput = {
  fen: string;
  question?: string;
  depth?: number;
  movetimeMs?: number;
  requestId?: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  startFen?: string;
  historySans?: string[];
};

export async function runCoachTurn(
  input: CoachInput,
  deps?: { provider?: LlmProvider; corpus?: CorpusFile },
): Promise<CoachResponse> {
  const chess = new Chess(input.fen);
  const fen = chess.fen();
  const positionKey = positionKeyFromFen(fen);
  const limits = clampLimits({ depth: input.depth, movetimeMs: input.movetimeMs });
  const corpus = deps?.corpus ?? safeCorpus();
  const packaged = corpus ? findPosition(corpus, fen) : null;
  const facts = boardFacts(chess);
  let engine: EngineResult | null = null;
  let engineError: string | undefined;
  try {
    engine = await analyzeFen(fen, limits, input.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    engineError = error instanceof EngineError ? error.message : "The engine did not return a result.";
  }

  const snapshot = {
    positionKey,
    fen,
    sideToMove: facts.sideToMove,
    terminal: engine?.terminal ?? null,
    board: {
      centralWedge: facts.centralWedge,
      inCheck: facts.inCheck,
      legalMoveCount: facts.legalMoveCount,
    },
    engine: engine
      ? {
          name: engine.engineName,
          bestMoveSan: engine.bestMoveSan,
          scoreWhiteLabel: engine.scoreWhiteLabel,
          depth: engine.depth,
          pvSan: engine.pvSan.slice(0, 8),
          stable: engine.stable,
          preference: engine.preference.status,
        }
      : null,
    sharedBaseline: packaged
      ? { version: corpus?.version, explanation: packaged.explanation, themes: packaged.themes }
      : null,
    limits,
  };

  const provider = deps?.provider ?? getProvider();
  const availability = await provider.available();
  const cacheKey = [positionKey, engine?.bestMove, engine?.depth, engine?.scoreWhiteLabel, limits.depth].join("|");
  let assessment = assessmentCache.get(cacheKey);
  let cached = Boolean(assessment);
  let mode: CoachResponse["mode"] = "engine-only";
  let modeReason = availability.ok ? undefined : availability.reason;

  if (!assessment) {
    cached = false;
    if (availability.ok) {
      try {
        const text = await provider.complete(buildAssessmentMessages(snapshot), {
          purpose: "assess",
          signal: input.signal,
        });
        const parsed = modelAssessmentFromText(text);
        if (!parsed) throw new Error("The model assessment was not usable JSON.");
        assessment = {
          source: "model",
          summary: parsed.summary,
          hypotheses: parsed.hypotheses,
          cached: false,
          independentOfUserQuestion: true,
        };
        mode = "model";
      } catch (error) {
        modeReason = error instanceof Error ? error.message : "The model assessment failed.";
        assessment = deterministicAssessment(snapshot, engine, facts.centralWedge);
      }
    } else {
      assessment = deterministicAssessment(snapshot, engine, facts.centralWedge);
    }
    assessmentCache.set(cacheKey, { ...assessment, cached: false });
  } else if (availability.ok && assessment.source === "model") {
    mode = "model";
  }
  assessment = { ...assessment, cached };

  const question = input.question?.trim() ?? "";
  const opening = recognizeOpening({ fen, startFen: input.startFen, sans: input.historySans });
  const openingGuide = guideForOpening(opening);
  const comparisons = question && engine?.score ? await compareProposed(fen, question, engine, limits, input.signal) : [];
  const themes = packaged?.themes ?? (facts.centralWedge ? ["closed-center"] : []);
  const patterns = question && corpus ? matchingPatterns(corpus, question, themes, fen) : [];
  const findings = question ? questionFindings(question, fen) : [];

  let reply = "";
  let modelHypotheses: Claim[] = [];
  if (question && mode === "model") {
    try {
      const text = await provider.complete(
        buildExamineMessages({
          assessment: { summary: assessment.summary, hypotheses: assessment.hypotheses },
          question,
          engine: snapshot.engine,
          comparisons: comparisons
            .filter((item) => item.score)
            .map((item) => ({
              san: item.san,
              scoreWhiteLabel: item.scoreWhiteLabel,
              depth: item.depth,
            })),
          patterns: patterns.map((pattern) => ({ id: pattern.id, statement: pattern.statement })),
          sessionAlreadyHeard: input.sessionId && sessionHas(input.sessionId, "structure-definition")
            ? ["structure-definition"]
            : [],
          openingGuide: openingGuide
            ? {
                title: openingGuide.title,
                summary: openingGuide.summary,
                whitePlans: openingGuide.whitePlans,
                blackPlans: openingGuide.blackPlans,
                structure: openingGuide.structure,
                setups: openingGuide.setups,
                trap: openingGuide.trap,
                label: openingGuide.label,
              }
            : null,
        }),
        { purpose: "examine", signal: input.signal },
      );
      const parsed = modelReplyFromText(text);
      if (!parsed) throw new Error("The model reply was not usable JSON.");
      reply = parsed.reply;
      modelHypotheses = provisionalModelClaims(parsed.hypotheses);
    } catch (error) {
      mode = "engine-only";
      modeReason = error instanceof Error ? error.message : "The model reply failed.";
      reply = "";
    }
  }

  const sessionShort = Boolean(input.sessionId && sessionHas(input.sessionId, "structure-definition"));
  if (!reply) {
    reply = deterministicReply({
      question,
      assessment,
      engine,
      comparisons,
      findings,
      patterns: patterns.map((pattern) => pattern.statement),
      modeReason,
      sessionShort,
      centralWedge: facts.centralWedge,
    });
  } else if (affirmsRookRetiresBreak(reply)) {
    reply += " That conclusion is not established: a rook move does not prove the pawn break was abandoned.";
  }

  if (openingGuide && question && asksAboutPlans(question)) {
    const sideNote = facts.sideToMove === "white" ? openingGuide.whitePlans : openingGuide.blackPlans;
    const curated = `Curated opening note, not engine-verified: ${openingGuide.title}. ${openingGuide.summary} ${sideNote}`;
    if (!/not engine-verified/i.test(reply)) reply = `${reply} ${curated}`.trim();
  }

  const claims = dedupeClaims([
    ...(opening ? [openingClaim(opening)] : []),
    ...(openingGuide && question && asksAboutPlans(question)
      ? [{
          id: "opening-guide",
          text: `Curated opening note, not engine-verified: ${openingGuide.title}. ${openingGuide.summary}`,
          status: "provisional" as const,
          kind: "strategic" as const,
          reason: "This is a short curated guide for the recognized opening. It is not an engine evaluation and it is not a mapped plan.",
          evidence: [`guide ${openingGuide.id}`, openingGuide.label],
        }]
      : []),
    ...serverClaims(engine, comparisons, findings),
    ...modelHypotheses,
    ...patterns.map((pattern) => ({
      id: `pattern-${pattern.id}`,
      text: pattern.statement,
      status: "provisional" as const,
      kind: "method" as const,
      reason: `Pattern ${pattern.id} matched this question's conditions (${pattern.applicability.description}). It is not applied to similar-looking boards that fail those conditions.`,
      evidence: ["Applicability checked against the question and this FEN."],
    })),
    ...(affirmsRookRetiresBreak(reply)
      ? [{
          id: "model-overclaim",
          text: "The reply affirmed that a rook move retires the f-pawn break. That affirmation is open.",
          status: "open" as const,
          kind: "causal" as const,
          reason: "Model confidence and wording do not promote a causal claim.",
          evidence: ["Server scan of the reply after the second pass."],
        }]
      : []),
  ]);

  if (facts.centralWedge) sessionRemember(input.sessionId ?? null, ["structure-definition"]);
  const invitation = claims.some((claim) => claim.status === "open") ? OPEN_INVITATION : undefined;
  if (invitation && !reply.includes(OPEN_INVITATION)) reply = `${reply} ${OPEN_INVITATION}`;

  return {
    requestId: input.requestId || "local",
    fen,
    positionKey,
    mode,
    modeReason,
    sequencing: { assessmentBeforeExamine: true, userQuestionVisibleToAssessment: false },
    assessment,
    reply: reply.trim(),
    claims,
    invitation,
    engine,
    comparisons,
    corpusVersion: corpus?.version ?? null,
    baselineRevisionId: packaged?.revisionId ?? null,
    patternsApplied: patterns.map((pattern) => pattern.id),
    sessionNote: sessionShort
      ? "This session already heard the structure point, so the long definition was not repeated. That is not a saved mastery profile."
      : undefined,
    engineError,
    opening,
    openingGuide,
  };
}

export async function runOrientation(
  fen: string,
  limits?: { depth?: number; movetimeMs?: number },
  signal?: AbortSignal,
  provider?: LlmProvider,
  history?: { startFen?: string; historySans?: string[] },
): Promise<CoachResponse> {
  return runCoachTurn(
    {
      fen,
      depth: limits?.depth,
      movetimeMs: limits?.movetimeMs,
      signal,
      question: undefined,
      startFen: history?.startFen,
      historySans: history?.historySans,
    },
    { provider },
  );
}

function safeCorpus(): CorpusFile | null {
  try {
    return loadPackagedCorpus();
  } catch {
    return null;
  }
}

function deterministicAssessment(
  snapshot: { sideToMove: string; fen: string },
  engine: EngineResult | null,
  centralWedge: boolean,
): Assessment {
  const structure = centralWedge
    ? "The d- and e-file pawns block each other, so this is a closed central wedge."
    : "The center is not a closed d/e wedge.";
  const search = !engine
    ? "No engine result is available."
    : engine.terminal
      ? engine.scoreWhiteLabel
      : engine.coverage === "not-in-cloud"
        ? "Lichess cloud eval has no stored line for this position. The reading is provisional and unverified."
        : engine.coverage === "cooling-down"
          ? "The engine is cooling down. Try again in about a minute. This reading is provisional."
          : engine.coverage === "timeout"
            ? "The cloud evaluation timed out. This reading is provisional and unverified."
            : `A ${engine.engineName} line at depth ${engine.depth} ended on ${engine.bestMoveSan ?? "no move"} with ${engine.scoreWhiteLabel}. That reports the search. It does not explain a plan.`;
  return {
    source: "deterministic",
    summary: `${snapshot.sideToMove === "white" ? "White" : "Black"} to move. ${structure} ${search}`,
    hypotheses: [
      {
        text: "One finite line does not decide which plan the position asks for.",
        status: "provisional",
        reason: "This hypothesis is independent of any student question and is not treated as proof.",
      },
    ],
    cached: false,
    independentOfUserQuestion: true,
  };
}

function deterministicReply(input: {
  question: string;
  assessment: Assessment;
  engine: EngineResult | null;
  comparisons: ComparisonResult[];
  findings: Claim[];
  patterns: string[];
  modeReason?: string;
  sessionShort: boolean;
  centralWedge: boolean;
}): string {
  const parts: string[] = [];
  parts.push(
    input.modeReason
      ? `Engine-only limited mode. ${input.modeReason}`
      : "Engine-only limited mode. No language model answered, so this is not model reasoning.",
  );
  if (input.sessionShort && input.centralWedge) {
    parts.push("The closed wedge is already on the board in this session.");
  } else {
    parts.push(input.assessment.summary);
  }
  if (input.engine?.coverage === "not-in-cloud") {
    parts.push(
      "This position is not in the Lichess cloud cache, so the reading is provisional and unverified. A nearby or earlier position may have a stored evaluation.",
    );
  } else if (input.engine?.coverage === "cooling-down") {
    parts.push("The engine is cooling down. Try again in about a minute.");
  } else if (input.engine?.coverage === "timeout") {
    parts.push("The cloud evaluation timed out. This reading is provisional and unverified.");
  }
  if (!input.question) {
    parts.push("Ask about the plan when you are ready. I will not narrate every move.");
    return parts.join(" ");
  }
  if (input.findings.some((claim) => claim.id === "f4-plan-open")) {
    parts.push(
      "Putting a rook on e1 does not decide the f4 break. If f4 is legal, the move still exists. Whether it remains the plan is open.",
    );
  }
  if (input.findings.some((claim) => claim.id === "ndf3-purpose-open")) {
    parts.push(
      "Ndf3 both occupies f3, which stops an immediate f-pawn push, and attacks new squares. Blocking the pawn does not prove the knight is only a defender.",
    );
  }
  if (input.findings.some((claim) => claim.id === "restraint-open")) {
    parts.push("A knight touching e5 does not prove that the strategy is restraint.");
  }
  if (input.comparisons.length && input.engine?.bestMoveSan) {
    const bits = input.comparisons
      .filter((item) => item.legal && item.score)
      .map((item) => `${item.san} scored ${item.scoreWhiteLabel} at depth ${item.depth}`);
    if (bits.length) {
      parts.push(
        `At the same limit, the search's first move ${input.engine.bestMoveSan} scored ${input.engine.scoreWhiteLabel}; ${bits.join("; ")}. The gap is not a cause.`,
      );
    }
  }
  const illegal = input.findings.filter((claim) => claim.id === "ndf3-not-here");
  if (illegal.length) parts.push(illegal[0].text);
  if (input.patterns.length) parts.push(input.patterns[0]);
  return parts.join(" ");
}

function serverClaims(engine: EngineResult | null, comparisons: ComparisonResult[], findings: Claim[]): Claim[] {
  const claims: Claim[] = [];
  if (engine?.terminal) {
    claims.push({
      id: "terminal",
      text: engine.scoreWhiteLabel,
      status: "mapped",
      kind: "board",
      reason: "The rules of the position say the game is over. No search was required.",
      evidence: [`terminal=${engine.terminal}`],
    });
  } else if (engine?.coverage === "not-in-cloud") {
    claims.push({
      id: "engine-unverified",
      text: "No stored Lichess cloud evaluation for this position. This answer is provisional and unverified.",
      status: "provisional",
      kind: "engine-report",
      reason: "A cache miss is not a search result. Nothing here was engine-checked.",
      evidence: ["lichess cloud 404"],
    });
  } else if (engine?.coverage === "cooling-down") {
    claims.push({
      id: "engine-cooldown",
      text: "The engine is cooling down after a rate limit. Try again in about a minute. This answer is provisional.",
      status: "provisional",
      kind: "engine-report",
      reason: "Lichess asked for one request at a time and returned 429. The pause is about 60 seconds.",
      evidence: ["lichess cloud 429"],
    });
  } else if (engine?.coverage === "timeout") {
    claims.push({
      id: "engine-timeout",
      text: "The cloud evaluation timed out. This answer is provisional and unverified.",
      status: "provisional",
      kind: "engine-report",
      reason: "The lookup was cancelled by the timeout before a stored line came back.",
      evidence: ["lichess cloud timeout"],
    });
  } else if (engine?.bestMoveSan && engine.pvLegal) {
    claims.push({
      id: "search-report",
      text: `This search at depth ${engine.depth} ended on ${engine.bestMoveSan}, ${engine.scoreWhiteLabel}. The PV ${engine.pvSan.join(" ") || engine.bestMoveSan} replays legally. Scores are from White's side.`,
      status: "mapped",
      kind: "engine-report",
      reason: "This quotes the finished search and a PV that was replayed. It is not a claim that the move is the truth of the position.",
      evidence: [`${engine.engineName}`, `depth ${engine.depth}`, `stable=${engine.stable}`],
    });
    claims.push({
      id: "engine-preference",
      text: `Engine preference: ${engine.bestMoveSan}.`,
      status: engine.preference.status,
      kind: "engine-preference",
      reason: engine.preference.reason,
      evidence: [`depth ${engine.depth}`, `stable=${engine.stable}`],
    });
  } else if (!engine) {
    claims.push({
      id: "engine-missing",
      text: "No engine result is available for this position.",
      status: "open",
      kind: "engine-report",
      reason: "Missing evidence stays open.",
      evidence: [],
    });
  }
  for (const comparison of comparisons) {
    if (!comparison.legal || !comparison.score || !engine?.score) continue;
    claims.push({
      id: `compare-${comparison.san}`,
      text: `At depth ${comparison.depth}, ${comparison.san} scored ${comparison.scoreWhiteLabel}, while the search's first move scored ${engine.scoreWhiteLabel}.`,
      status: "mapped",
      kind: "comparison",
      reason: "Both numbers come from searches at the same depth and movetime. The numbers are not a cause.",
      evidence: [`searchmoves ${comparison.uci}`, `depth ${comparison.depth}`],
    });
    claims.push({
      id: `compare-cause-${comparison.san}`,
      text: `The score gap between ${engine.bestMoveSan} and ${comparison.san} does not establish why one move fits the plan.`,
      status: "open",
      kind: "causal",
      reason: "A score difference is not a mechanism.",
      evidence: ["Comparable-limit searches only."],
    });
  }
  claims.push(...findings);
  return claims;
}

async function compareProposed(
  fen: string,
  question: string,
  engine: EngineResult,
  limits: SearchLimits,
  signal?: AbortSignal,
): Promise<ComparisonResult[]> {
  if (engine.terminal) return [];
  const refs = extractMoveRefs(question, fen);
  const chosen = refs.legal.filter((move) => move.uci !== engine.bestMove).slice(0, 2);
  const results: ComparisonResult[] = [];
  for (const move of chosen) {
    try {
      const alt = await analyzeFen(fen, limits, signal, [move.uci]);
      results.push({
        san: move.san,
        uci: move.uci,
        legal: true,
        score: alt.score,
        scoreWhiteLabel: alt.scoreWhiteLabel,
        depth: alt.depth,
        pvSan: alt.pvSan,
      });
    } catch {
      results.push({
        san: move.san,
        uci: move.uci,
        legal: true,
        score: null,
        scoreWhiteLabel: "no score",
        depth: limits.depth,
        pvSan: [],
      });
    }
  }
  return results;
}

function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  const result: Claim[] = [];
  for (const claim of claims) {
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    result.push(claim);
  }
  return result;
}

