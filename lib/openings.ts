import { readFileSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { positionKeyFromFen, START_FEN } from "@/lib/fen";
import type { Claim, OpeningRecognition } from "@/lib/types";

export type OpeningHit = { eco: string; name: string; pgn: string; plies: number };

export type OpeningIndex = {
  source: { name: string; commit: string; date: string; license: string; url: string };
  rows: number;
  skipped: number;
  uniquePositions: number;
  ecoCount: number;
  ambiguousPositions: number;
  positions: Record<string, { plies: number; hits: OpeningHit[] }>;
};

let cached: OpeningIndex | null = null;

export function loadOpeningIndex(): OpeningIndex {
  if (!cached) {
    const file = path.join(process.cwd(), "openings", "index.json");
    cached = JSON.parse(readFileSync(file, "utf8")) as OpeningIndex;
  }
  return cached;
}

export function catalogFullmove(plies: number): number {
  return Math.floor(plies / 2) + 1;
}

/** Keep the longer catalog line. Equal lengths keep every distinct name. */
export function preferDeeper(existing: OpeningHit[] | undefined, incoming: OpeningHit[]): OpeningHit[] {
  const nextPly = Math.max(...incoming.map((hit) => hit.plies));
  const keptIncoming = incoming.filter((hit) => hit.plies === nextPly);
  if (!existing?.length) return dedupe(keptIncoming);
  const oldPly = Math.max(...existing.map((hit) => hit.plies));
  if (nextPly > oldPly) return dedupe(keptIncoming);
  if (nextPly < oldPly) return existing;
  return dedupe([...existing, ...keptIncoming]);
}

function dedupe(hits: OpeningHit[]): OpeningHit[] {
  const seen = new Set<string>();
  const out: OpeningHit[] = [];
  for (const hit of hits) {
    const key = `${hit.eco}\0${hit.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

export function recognizeOpening(
  input: { fen: string; startFen?: string; sans?: string[] },
  index: OpeningIndex = loadOpeningIndex(),
): OpeningRecognition | null {
  const played = input.sans ?? [];
  let historyUsed = false;
  let fens: string[] = [];
  if (played.length) {
    try {
      const chess = new Chess(input.startFen ?? START_FEN);
      fens = [chess.fen()];
      for (const san of played) {
        if (!chess.move(san)) return lookupFen(input.fen, index);
        fens.push(chess.fen());
      }
      if (positionKeyFromFen(chess.fen()) !== positionKeyFromFen(new Chess(input.fen).fen())) {
        return lookupFen(input.fen, index);
      }
      historyUsed = true;
    } catch {
      return lookupFen(input.fen, index);
    }
  }
  if (!historyUsed) return lookupFen(input.fen, index);

  let best: { atPly: number; hits: OpeningHit[] } | null = null;
  for (let ply = 0; ply < fens.length; ply += 1) {
    const entry = index.positions[positionKeyFromFen(fens[ply])];
    if (!entry) continue;
    if (!best || ply > best.atPly) best = { atPly: ply, hits: entry.hits };
  }
  const currentEntry = index.positions[positionKeyFromFen(fens[fens.length - 1])];
  const fenFullmove = fullmoveOf(fens[fens.length - 1]);
  if (!best) return null;
  const current = Boolean(currentEntry) && best.atPly === fens.length - 1;
  return describe(best.hits, {
    fenFullmove,
    current,
    matchedAtPly: best.atPly,
    historyUsed: true,
    source: index.source,
  });
}

function lookupFen(fen: string, index: OpeningIndex): OpeningRecognition | null {
  let canonical: string;
  try {
    canonical = new Chess(fen).fen();
  } catch {
    return null;
  }
  const entry = index.positions[positionKeyFromFen(canonical)];
  if (!entry) return null;
  return describe(entry.hits, {
    fenFullmove: fullmoveOf(canonical),
    current: true,
    matchedAtPly: null,
    historyUsed: false,
    source: index.source,
  });
}

function describe(
  hits: OpeningHit[],
  facts: {
    fenFullmove: number;
    current: boolean;
    matchedAtPly: number | null;
    historyUsed: boolean;
    source: OpeningIndex["source"];
  },
): OpeningRecognition {
  const plies = Math.max(...hits.map((hit) => hit.plies));
  const names = [...new Set(hits.map((hit) => hit.name))];
  const ecos = [...new Set(hits.map((hit) => hit.eco))];
  const title = names.length === 1 ? `${ecos.join("/")} ${names[0]}` : names.map((name, i) => `${hits[i]?.eco ?? ecos[0]} ${name}`).join(" or ");
  const label = facts.historyUsed && !facts.current
    ? `Passed through ${title} at ply ${facts.matchedAtPly} · not the current catalog position · provisional`
    : `${title} · provisional`;
  return {
    status: "provisional",
    label,
    names,
    ecos,
    ambiguous: names.length > 1,
    catalogPlies: plies,
    catalogFullmove: catalogFullmove(plies),
    fenFullmove: facts.fenFullmove,
    currentIsCatalogPosition: facts.current,
    matchedAtPly: facts.matchedAtPly,
    historyUsed: facts.historyUsed,
    source: facts.source,
  };
}

export function openingClaim(opening: OpeningRecognition): Claim {
  const nameList = opening.names.join("; ");
  const order = opening.historyUsed
    ? opening.currentIsCatalogPosition
      ? `The imported moves reach this catalog position at ply ${opening.matchedAtPly}. The catalog line itself is ${opening.catalogPlies} plies (fullmove ${opening.catalogFullmove} in that line).`
      : `The deepest catalog prefix on the imported line is ply ${opening.matchedAtPly}. The current position is past that entry, so the name does not describe the current position as a catalog leaf.`
    : `This FEN matches the catalog position. The catalog line is ${opening.catalogPlies} plies (fullmove ${opening.catalogFullmove}). This FEN's fullmove counter is ${opening.fenFullmove}. A FEN does not establish that move order.`;
  return {
    id: "opening-catalog",
    text: `Catalog recognition: ${nameList}. ${order} This is a name from the bundled opening list, not a verdict that the move or a plan is good.`,
    status: "provisional",
    kind: "catalog",
    reason:
      "A catalog name is source recognition. Depth, a legal catalog line, and overlap with a principal variation do not promote it to a mapped explanation.",
    evidence: [
      `${opening.source.name} ${opening.source.commit}`,
      opening.source.license,
      `catalog plies ${opening.catalogPlies}`,
      `fen fullmove ${opening.fenFullmove}`,
    ],
  };
}

function fullmoveOf(fen: string): number {
  const value = Number(fen.split(" ")[5]);
  return Number.isFinite(value) ? value : 1;
}
