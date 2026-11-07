import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Chess, type Square } from "chess.js";
import { hasCentralWedge, isLegalSan, pieceOn } from "@/lib/board-facts";
import { positionKeyFromFen } from "@/lib/fen";
import type { ClaimStatus } from "@/lib/types";

export type CorpusCheck =
  | { type: "pieceOn"; square: string; color: "w" | "b"; piece: "p" | "n" | "b" | "r" | "q" | "k" }
  | { type: "moveLegal"; san: string }
  | { type: "centralWedge" }
  | { type: "storedSearch"; bestMove: string; minDepth: number };

export type CorpusClaim = {
  id: string;
  text: string;
  kind: "board" | "engine-report" | "engine-preference" | "strategic" | "causal" | "method" | "catalog";
  status: ClaimStatus;
  reason: string;
  evidence: string[];
  check?: CorpusCheck;
};

export type CorpusEngine = {
  name: string;
  depth: number;
  bestMove: string;
  bestMoveSan: string;
  scoreWhiteCp: number | null;
  scoreWhiteMate: number | null;
  scoreWhiteLabel: string;
  pv: string[];
  pvSan: string[];
  stable: boolean;
};

export type CorpusPosition = {
  id: string;
  revisionId: string;
  positionKey: string;
  fen: string;
  themes: string[];
  explanation: string;
  claims: CorpusClaim[];
  engine?: CorpusEngine;
  provenance: {
    source: "maintainer-seed";
    corpusVersion: string;
    note: string;
  };
};

export type CorpusPattern = {
  id: string;
  statement: string;
  status: "provisional" | "open";
  applicability: {
    description: string;
    questionAllOf: string[];
    questionAnyOf?: string[];
    notWhenQuestionMatches?: string[];
    positionThemesAny?: string[];
    requiresMoveFrom?: { san: string; from: string };
  };
};

export type CorpusFile = {
  version: string;
  positions: CorpusPosition[];
  patterns: CorpusPattern[];
};

const FORBIDDEN = [
  "password",
  "passwordhash",
  "email",
  "audio",
  "transcript",
  "userid",
  "session",
  "apikey",
  "authorization",
  "cookie",
  "secret",
  "dialogue",
  "username",
  "vote",
];

const STATUS_RANK: Record<ClaimStatus, number> = { open: 0, provisional: 1, mapped: 2 };

export function corpusDir(): string {
  return process.env.CORPUS_DIR || path.join(process.cwd(), "corpus");
}

export function loadPackagedCorpus(dir = corpusDir()): CorpusFile {
  const positions = JSON.parse(readFileSync(path.join(dir, "positions.json"), "utf8")) as {
    version: string;
    positions: CorpusPosition[];
  };
  const patterns = JSON.parse(readFileSync(path.join(dir, "patterns.json"), "utf8")) as {
    patterns: CorpusPattern[];
  };
  return { version: positions.version, positions: positions.positions, patterns: patterns.patterns };
}

export function validateCorpus(corpus: CorpusFile, raw?: string): string[] {
  const errors: string[] = [];
  const serialized = raw ?? JSON.stringify(corpus);
  if (serialized.length > 1_000_000) errors.push("Corpus exceeds the size bound.");
  collectForbidden(corpus, "$", errors);
  if (!corpus.version) errors.push("Corpus version is missing.");
  if (corpus.positions.length > 200) errors.push("Too many positions.");
  const keys = new Set<string>();
  for (const position of corpus.positions) {
    if (keys.has(position.positionKey)) errors.push(`Duplicate position key ${position.positionKey}`);
    keys.add(position.positionKey);
    try {
      const chess = new Chess(position.fen);
      if (positionKeyFromFen(chess.fen()) !== position.positionKey) {
        errors.push(`Position ${position.id} key does not match its canonical FEN.`);
      }
    } catch {
      errors.push(`Position ${position.id} has an illegal FEN.`);
    }
    if (!position.provenance?.source || !position.provenance.corpusVersion) {
      errors.push(`Position ${position.id} is missing provenance.`);
    }
    if (position.claims.length > 40) errors.push(`Position ${position.id} has too many claims.`);
    for (const claim of position.claims) {
      if (claim.text.length > 2000) errors.push(`Claim ${claim.id} is too long.`);
      if (claim.kind === "strategic" && claim.status === "mapped") {
        errors.push(`Strategic claim ${claim.id} cannot be mapped.`);
      }
      if (claim.kind === "causal" && claim.status === "mapped") {
        errors.push(`Causal claim ${claim.id} cannot be mapped.`);
      }
      if (claim.status === "mapped" && !claim.check) {
        errors.push(`Mapped claim ${claim.id} has no check.`);
      }
      if (claim.status === "mapped" && claim.evidence.length === 0) {
        errors.push(`Mapped claim ${claim.id} has no evidence.`);
      }
      if (claim.check?.type === "moveLegal" && !isPlausibleSan(claim.check.san)) {
        errors.push(`Claim ${claim.id} has an invalid move.`);
      }
      if (claim.check?.type === "storedSearch") {
        if (!position.engine) errors.push(`Claim ${claim.id} cites a search that is not stored.`);
        else if (!pvReplays(position.fen, position.engine.pv)) {
          errors.push(`Stored PV for ${position.id} is illegal.`);
        } else if (position.engine.bestMove !== claim.check.bestMove) {
          errors.push(`Claim ${claim.id} does not match the stored best move.`);
        } else if (position.engine.depth < claim.check.minDepth) {
          errors.push(`Claim ${claim.id} cites a search below its minimum depth.`);
        }
      }
    }
  }
  return errors;
}

function isPlausibleSan(san: string): boolean {
  return /^(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)$/.test(san);
}

function collectForbidden(value: unknown, pointer: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbidden(item, `${pointer}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.includes(key.toLowerCase())) {
      errors.push(`Forbidden field ${key} at ${pointer}.`);
    }
    collectForbidden(child, `${pointer}.${key}`, errors);
  }
}

export function presentPosition(position: CorpusPosition): CorpusPosition {
  return {
    ...position,
    claims: position.claims.map((claim) => presentClaim(position, claim)),
  };
}

export function presentClaim(position: CorpusPosition, claim: CorpusClaim): CorpusClaim {
  let status = claim.status;
  let reason = claim.reason;
  const cap = (max: ClaimStatus, why: string) => {
    if (STATUS_RANK[status] > STATUS_RANK[max]) {
      status = max;
      reason = `${reason} ${why}`;
    }
  };
  if (claim.kind === "strategic" || claim.kind === "method" || claim.kind === "catalog") {
    cap("provisional", "Strategic or methodological text is not mapped just because it is in the corpus.");
  }
  if (claim.kind === "causal") {
    cap("open", "A causal reading stays open unless a separate board or engine check exists.");
  }
  if (claim.kind === "engine-preference") {
    cap("provisional", "A search preference is not an explanation proof.");
    if ((position.engine?.depth ?? 0) < 8 || position.engine?.stable === false) {
      cap("open", "Low depth or unstable ordering keeps the preference open.");
    }
  }
  if (claim.check) {
    const passed = runCheck(position, claim.check);
    if (!passed) {
      status = "open";
      reason = "The check failed on this position, so the claim is open rather than trusted from the file.";
    }
  } else if (status === "mapped") {
    status = "open";
    reason = "A corpus file cannot grant mapped status without a check. Being generated or seeded is not enough.";
  }
  if (STATUS_RANK[status] > STATUS_RANK[claim.status]) status = claim.status;
  return { ...claim, status, reason };
}

export function runCheck(position: CorpusPosition, check: CorpusCheck): boolean {
  let chess: Chess;
  try {
    chess = new Chess(position.fen);
  } catch {
    return false;
  }
  if (check.type === "pieceOn") return pieceOn(chess, check.square, check.color, check.piece);
  if (check.type === "moveLegal") return isLegalSan(chess, check.san);
  if (check.type === "centralWedge") return hasCentralWedge(chess);
  if (!position.engine) return false;
  if (position.engine.bestMove !== check.bestMove) return false;
  if (position.engine.depth < check.minDepth) return false;
  return pvReplays(position.fen, position.engine.pv);
}

export function pvReplays(fen: string, pv: string[]): boolean {
  try {
    const chess = new Chess(fen);
    for (const uci of pv) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false;
      const move = chess.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci[4] as "q" | "r" | "b" | "n" | undefined,
      });
      if (!move) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function findPosition(corpus: CorpusFile, fenOrKey: string): CorpusPosition | null {
  const key = fenOrKey.includes("/") ? positionKeyFromFen(new Chess(fenOrKey).fen()) : fenOrKey;
  const found = corpus.positions.find((position) => position.positionKey === key);
  return found ? presentPosition(found) : null;
}

export function matchingPatterns(
  corpus: CorpusFile,
  question: string,
  themes: string[],
  fen: string,
): CorpusPattern[] {
  return corpus.patterns.filter((pattern) => patternApplies(pattern, question, themes, fen));
}

export function patternApplies(
  pattern: CorpusPattern,
  question: string,
  themes: string[],
  fen: string,
): boolean {
  const text = question.toLowerCase();
  const rules = pattern.applicability;
  if (rules.positionThemesAny?.length && !rules.positionThemesAny.some((theme) => themes.includes(theme))) {
    return false;
  }
  if (!rules.questionAllOf.every((expression) => new RegExp(expression, "i").test(text))) return false;
  if (rules.questionAnyOf?.length && !rules.questionAnyOf.some((expression) => new RegExp(expression, "i").test(text))) {
    return false;
  }
  if (rules.notWhenQuestionMatches?.some((expression) => new RegExp(expression, "i").test(text))) return false;
  if (rules.requiresMoveFrom) {
    const chess = new Chess(fen);
    try {
      const move = chess.move(rules.requiresMoveFrom.san);
      if (!move || move.from !== rules.requiresMoveFrom.from) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function exportCorpusText(dir = corpusDir()): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}
