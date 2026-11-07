export const OPEN_INVITATION = "I'm still learning this spot, want to help?";

export type ClaimStatus = "mapped" | "provisional" | "open";

export type ClaimKind =
  | "engine-report"
  | "engine-preference"
  | "board"
  | "comparison"
  | "strategic"
  | "causal"
  | "method"
  | "catalog";

export type Claim = {
  id: string;
  text: string;
  status: ClaimStatus;
  kind: ClaimKind;
  reason: string;
  evidence: string[];
};

export type EngineScore = {
  kind: "cp" | "mate";
  /** Always from White's point of view. Positive means White is better. */
  value: number;
  bound?: "lower" | "upper";
};

export type EngineResult = {
  available: true;
  terminal: null | "checkmate" | "stalemate" | "draw";
  winner: "white" | "black" | null;
  bestMove: string | null;
  bestMoveSan: string | null;
  ponder: string | null;
  depth: number;
  seldepth: number | null;
  score: EngineScore | null;
  scoreWhiteLabel: string;
  pv: string[];
  pvSan: string[];
  pvLegal: boolean;
  nodes: number | null;
  nps: number | null;
  timeMs: number | null;
  stable: boolean;
  engineName: string;
  whitePov: true;
  preference: {
    status: "provisional" | "open";
    reason: string;
  };
  searchedMove?: string | null;
};

export type Hypothesis = {
  text: string;
  status: "provisional" | "open";
  reason: string;
};

export type Assessment = {
  source: "model" | "deterministic";
  summary: string;
  hypotheses: Hypothesis[];
  cached: boolean;
  independentOfUserQuestion: true;
};

export type ComparisonResult = {
  san: string;
  uci: string;
  legal: boolean;
  score: EngineScore | null;
  scoreWhiteLabel: string;
  depth: number;
  pvSan: string[];
};

export type OpeningRecognition = {
  status: "provisional";
  label: string;
  names: string[];
  ecos: string[];
  ambiguous: boolean;
  catalogPlies: number | null;
  catalogFullmove: number | null;
  fenFullmove: number;
  currentIsCatalogPosition: boolean;
  matchedAtPly: number | null;
  historyUsed: boolean;
  source: { name: string; commit: string; date: string; license: string; url: string };
};

export type CoachMode = "model" | "engine-only";

export type CoachResponse = {
  requestId: string;
  fen: string;
  positionKey: string;
  mode: CoachMode;
  modeReason?: string;
  sequencing: {
    assessmentBeforeExamine: true;
    userQuestionVisibleToAssessment: false;
  };
  assessment: Assessment;
  reply: string;
  claims: Claim[];
  invitation?: string;
  engine: EngineResult | null;
  comparisons: ComparisonResult[];
  corpusVersion: string | null;
  baselineRevisionId: string | null;
  patternsApplied: string[];
  sessionNote?: string;
  engineError?: string;
  opening?: OpeningRecognition | null;
};
