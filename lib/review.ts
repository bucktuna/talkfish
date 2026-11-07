import { Chess } from "chess.js";
import { boardFacts } from "@/lib/board-facts";
import { analyzeFen } from "@/lib/engine";
import { START_FEN } from "@/lib/fen";
import { HttpError } from "@/lib/http/errors";
import { ImportError, importPosition } from "@/lib/import-position";
import { guideForOpening } from "@/lib/opening-guides";
import { recognizeOpening } from "@/lib/openings";
import type { EngineResult, EngineScore, GameReview, ReviewMoment } from "@/lib/types";
import { whiteMilli } from "@/lib/white-score";

const MAX_NETWORK = 8;
const PIECE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export async function reviewGame(input: {
  startFen?: string;
  sans?: string[];
  pgn?: string;
  player?: "white" | "black" | null;
  signal?: AbortSignal;
}): Promise<GameReview> {
  const loaded = loadLine(input);
  const chess = new Chess(loaded.startFen);
  const fens = [chess.fen()];
  for (const san of loaded.sans) {
    let move;
    try {
      move = chess.move(san);
    } catch {
      move = null;
    }
    if (!move) throw new HttpError(400, `Illegal move in the game: ${san}.`);
    fens.push(chess.fen());
  }

  const opening = recognizeOpening({ fen: fens[fens.length - 1], startFen: loaded.startFen, sans: loaded.sans });
  const openingGuide = guideForOpening(opening);
  const heuristic = heuristicMoments(fens, loaded.sans);
  const interesting = new Set(heuristic.map((moment) => moment.ply));
  const probed = new Map<number, EngineResult>();
  let cloudHits = 0;
  let cloudMisses = 0;
  let network = 0;
  let coolingDown = false;
  let timedOut = false;

  for (const index of probeOrder(fens.length, [...interesting])) {
    if (network >= MAX_NETWORK || coolingDown || timedOut) break;
    if (input.signal?.aborted) {
      const error = new Error("Analysis cancelled");
      error.name = "AbortError";
      throw error;
    }
    const result = await analyzeFen(fens[index], { depth: 12, movetimeMs: 4000 }, input.signal);
    probed.set(index, result);
    if (result.fromCache === false) network += 1;
    if (result.coverage === "evaluated") cloudHits += 1;
    else if (result.coverage === "not-in-cloud") cloudMisses += 1;
    if (result.coverage === "cooling-down") coolingDown = true;
    if (result.coverage === "timeout") timedOut = true;
  }

  const engineMoments = engineSwings(fens, loaded.sans, probed);
  const enginePlies = new Set(engineMoments.map((moment) => moment.ply));
  const keptHeuristic = heuristic.filter((moment) => !enginePlies.has(moment.ply) && moment.label !== "Checkmate");
  const rules = ruleMoments(fens, loaded.sans);
  const moments = [...engineMoments, ...keptHeuristic, ...rules]
    .sort((a, b) => severity(b) - severity(a) || a.ply - b.ply)
    .slice(0, 6);
  const uncastled = lateUncastled(fens);

  const recommendations = buildRecommendations({
    guide: openingGuide,
    engineMoments,
    heuristic: keptHeuristic,
    uncastled,
    player: input.player ?? null,
  });

  const openingText = opening
    ? `Opening: ${opening.names.join("; ")}.`
    : "The moves did not match a bundled opening name.";
  const stall = coolingDown
    ? "The engine is cooling down, so later positions were not looked up. "
    : timedOut
      ? "A cloud lookup timed out, so later positions were not checked. "
      : "";
  const summary = `${loaded.sans.length} plies. ${openingText} Stored cloud evaluations on the positions that were checked: ${cloudHits}. Checked positions missing from the cache: ${cloudMisses}. ${stall}Moments marked Engine-verified quote a cloud swing. Heuristic moments are board counts, not engine proof. This is one game, not a verdict.`;

  return {
    opening,
    openingGuide,
    summary,
    moments,
    recommendations,
    cloudHits,
    cloudMisses,
    coolingDown,
    plies: loaded.sans.length,
  };
}

function loadLine(input: { startFen?: string; sans?: string[]; pgn?: string }): { startFen: string; sans: string[] } {
  if (input.pgn?.trim()) {
    try {
      const imported = importPosition(input.pgn);
      return { startFen: imported.startFen, sans: imported.sans };
    } catch (error) {
      if (error instanceof ImportError) throw new HttpError(400, error.message);
      throw new HttpError(400, "Could not read that PGN.");
    }
  }
  const sans = input.sans ?? [];
  if (!sans.length) throw new HttpError(400, "Load a game with moves before reviewing.");
  const startFen = input.startFen?.trim() || START_FEN;
  try {
    const chess = new Chess(startFen);
    return { startFen: chess.fen(), sans };
  } catch {
    throw new HttpError(400, "That starting FEN is not legal.");
  }
}

function probeOrder(length: number, interesting: number[]): number[] {
  const order: number[] = [];
  const push = (index: number) => {
    if (index >= 0 && index < length && !order.includes(index)) order.push(index);
  };
  const opening = Math.min(length, 12);
  for (let i = 0; i < opening; i += 1) push(i);
  for (const ply of interesting) {
    push(ply - 1);
    push(ply);
  }
  for (let i = 14; i < length; i += 8) {
    push(i);
    push(Math.min(length - 1, i + 1));
  }
  return order;
}

function engineSwings(fens: string[], sans: string[], probed: Map<number, EngineResult>): ReviewMoment[] {
  const moments: ReviewMoment[] = [];
  for (let ply = 1; ply < fens.length; ply += 1) {
    const before = probed.get(ply - 1);
    const after = probed.get(ply);
    if (!before || !after || before.coverage !== "evaluated" || after.coverage !== "evaluated") continue;
    if (!before.score || !after.score) continue;
    const side = new Chess(fens[ply - 1]).turn() === "w" ? "white" : "black";
    const loss = moverLoss(before.score, after.score, side);
    if (loss < 100) continue;
    const label = loss >= 300 ? "Blunder" : loss >= 180 ? "Mistake" : "Inaccuracy";
    moments.push({
      ply,
      fen: fens[ply],
      san: sans[ply - 1],
      side,
      source: "engine",
      label,
      note: `Engine-verified: ${sans[ply - 1]} changed the stored cloud evaluation by about ${Math.round(loss)} centipawns against ${side} (${before.scoreWhiteLabel} to ${after.scoreWhiteLabel}). Depths ${before.depth} and ${after.depth}. A stored line is a clue, not a full explanation.`,
    });
  }
  return moments.sort((a, b) => severity(b) - severity(a));
}

function moverLoss(before: EngineScore, after: EngineScore, side: "white" | "black"): number {
  const delta = whiteMilli(after) - whiteMilli(before);
  return side === "white" ? -delta : delta;
}

function heuristicMoments(fens: string[], sans: string[]): ReviewMoment[] {
  const moments: ReviewMoment[] = [];
  for (let ply = 1; ply < fens.length; ply += 1) {
    const before = new Chess(fens[ply - 1]);
    const side = before.turn() === "w" ? "white" : "black";
    // Settle after the mover's next move when it exists, so a capture that is recaptured
    // on the following ply (d4 cxd4 Nxd4) is not called a pawn slip.
    const settled = fens[ply + 2] ?? fens[ply + 1] ?? fens[ply];
    const loss = materialLoss(fens[ply - 1], settled, side);
    if (loss < 1) continue;
    const facts = boardFacts(new Chess(fens[ply]));
    const factText = [
      facts.inCheck ? "the king is in check" : "",
      facts.centralWedge ? "the center is a closed pawn wedge" : "",
      facts.checkmate ? "the position is checkmate" : "",
    ]
      .filter(Boolean)
      .join(", ");
    const label = loss >= 2 ? "Lost material" : "Possible pawn slip";
    moments.push({
      ply,
      fen: fens[ply],
      san: sans[ply - 1],
      side,
      source: "heuristic",
      label,
      note: `Heuristic, not engine-verified: after ${sans[ply - 1]}, ${side} is down about ${loss} point${loss === 1 ? "" : "s"} on a piece count once the reply is included.${factText ? ` On the board, ${factText}.` : ""} This is a board count, not an engine verdict.`,
    });
  }
  const pieces = moments.filter((moment) => moment.label === "Lost material");
  if (pieces.length) return pieces;
  return moments.filter((moment) => moment.label === "Possible pawn slip").slice(0, 1);
}

function materialLoss(beforeFen: string, afterFen: string, side: "white" | "black"): number {
  const delta = balance(new Chess(afterFen)) - balance(new Chess(beforeFen));
  const loss = side === "white" ? -delta : delta;
  return loss > 0 ? loss : 0;
}

function balance(chess: Chess): number {
  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = PIECE[piece.type] ?? 0;
      score += piece.color === "w" ? value : -value;
    }
  }
  return score;
}

function ruleMoments(fens: string[], sans: string[]): ReviewMoment[] {
  const moments: ReviewMoment[] = [];
  for (let ply = 1; ply < fens.length; ply += 1) {
    const chess = new Chess(fens[ply]);
    const facts = boardFacts(chess);
    if (!facts.checkmate && !facts.stalemate) continue;
    const side = new Chess(fens[ply - 1]).turn() === "w" ? "white" : "black";
    moments.push({
      ply,
      fen: fens[ply],
      san: sans[ply - 1],
      side,
      source: "rules",
      label: facts.checkmate ? "Checkmate" : "Stalemate",
      note: facts.checkmate
        ? "The rules say this move is checkmate. No cloud evaluation was required."
        : "The rules say this move is stalemate. No cloud evaluation was required.",
    });
  }
  return moments;
}

function lateUncastled(fens: string[]): boolean {
  const late = fens[Math.min(fens.length - 1, 20)];
  if (!late) return false;
  const chess = new Chess(late);
  if (Number(late.split(" ")[5]) < 8) return false;
  const whiteKing = chess.get("e1");
  const blackKing = chess.get("e8");
  const queens = chess.board().some((row) => row.some((piece) => piece?.type === "q"));
  const whiteHome = Boolean(whiteKing && whiteKing.type === "k" && whiteKing.color === "w");
  const blackHome = Boolean(blackKing && blackKing.type === "k" && blackKing.color === "b");
  return queens && (whiteHome || blackHome);
}

function buildRecommendations(input: {
  guide: GameReview["openingGuide"];
  engineMoments: ReviewMoment[];
  heuristic: ReviewMoment[];
  uncastled: boolean;
  player: "white" | "black" | null;
}): string[] {
  const items: string[] = [];
  const owned = (moment: ReviewMoment) => Boolean(input.player && moment.side === input.player);
  if (input.guide) {
    items.push(`Try this setup: ${input.guide.setups} Curated note for the ${input.guide.title}, not engine-verified.`);
  }
  if (input.engineMoments[0]) {
    const top = input.engineMoments[0];
    const lead = owned(top) ? `Your ${top.san}` : `The move ${top.san}`;
    items.push(
      `${lead} is the clearest engine-checked moment (${top.label.toLowerCase()}). Revisit that position and compare it with one developing move. One cloud line is a clue, not a grade for the whole game.`,
    );
  } else {
    items.push(
      "Most of this game is outside the Lichess cloud cache, so the middlegame notes are heuristic. An earlier position, while the opening is still on the board, is more likely to have a stored evaluation.",
    );
  }
  if (input.heuristic[0]) {
    const moment = input.heuristic[0];
    const lead = owned(moment) ? `your ${moment.san}` : moment.san;
    items.push(
      `Watch for this pattern: ${lead} left material where the reply could take it. Before you move, name the piece the opponent can capture.`,
    );
  } else if (input.guide) {
    items.push(`A common mistake to watch: ${input.guide.trap} That warning is curated, not engine-verified.`);
  } else if (input.uncastled) {
    items.push("A practical theme from this game: castle before the center opens, while the queens are still on.");
  } else {
    items.push("For the next game, pick one habit: develop the knights and bishops, then castle, before sending the queen out hunting.");
  }
  return items.slice(0, 3);
}

function severity(moment: ReviewMoment): number {
  if (moment.label === "Blunder" || moment.label === "Lost material") return 4;
  if (moment.label === "Mistake" || moment.label === "Checkmate") return 3;
  if (moment.label === "Inaccuracy" || moment.label === "Stalemate") return 2;
  return 1;
}
