import { Chess } from "chess.js";
import { boardFacts, knightAttacksFrom } from "@/lib/board-facts";
import { analyzeFen } from "@/lib/engine";
import { HttpError } from "@/lib/http/errors";
import { getProvider, type LlmProvider } from "@/lib/llm";
import { guideForOpening } from "@/lib/opening-guides";
import { recognizeOpening } from "@/lib/openings";
import { speakChessText } from "@/lib/speak-san";
import type { EngineResult, EngineScore, OpeningGuideView, PositionGist } from "@/lib/types";

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const WORD: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export type GistLines = {
  balance: string;
  whitePlan: string;
  blackPlan: string;
  watch: string;
  bestMove: string;
};

export function evalWords(score: EngineScore): string {
  if (score.kind === "mate") {
    if (score.value > 0) return `White is winning: mate in ${score.value}`;
    if (score.value < 0) return `Black is winning: mate in ${-score.value}`;
    return "The position is mate";
  }
  const cp = score.value;
  if (Math.abs(cp) < 40) return "The position is about equal";
  const side = cp > 0 ? "White" : "Black";
  const mag = Math.abs(cp);
  const degree = mag < 90 ? "a bit better" : mag < 200 ? "better" : mag < 450 ? "much better" : "winning";
  return `${side} is ${degree}`;
}

export function explainPosition(
  input: { fen: string; startFen?: string; historySans?: string[]; signal?: AbortSignal },
  deps?: { provider?: LlmProvider; analyze?: typeof analyzeFen },
): Promise<PositionGist> {
  let chess: Chess;
  try {
    chess = new Chess(input.fen);
  } catch {
    throw new HttpError(400, "That FEN is not legal.");
  }
  return explainChess(chess, input, deps);
}

async function explainChess(
  chess: Chess,
  input: { startFen?: string; historySans?: string[]; signal?: AbortSignal },
  deps?: { provider?: LlmProvider; analyze?: typeof analyzeFen },
): Promise<PositionGist> {
  const fen = chess.fen();
  const analyze = deps?.analyze ?? analyzeFen;
  let engine: EngineResult | null = null;
  let engineNote: string | null = null;
  try {
    engine = await analyze(fen, { depth: 12, movetimeMs: 4000 }, input.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    engineNote = error instanceof Error ? error.message : "The engine did not return a result.";
  }
  const opening = recognizeOpening({ fen, startFen: input.startFen, sans: input.historySans });
  const guide = guideForOpening(opening);
  const lines = templateLines(chess, engine, guide, engineNote);
  const source = gistSource(engine);
  const provider = deps?.provider ?? getProvider();
  const phrased = await phraseLines(lines, source, provider, input.signal);
  const text = joinLines(phrased.lines);
  return {
    fen,
    source,
    phrasing: phrased.phrasing,
    modelNote: phrased.modelNote,
    ...phrased.lines,
    text,
    spoken: speakChessText(text),
  };
}

export function templateLines(
  chess: Chess,
  engine: EngineResult | null,
  guide: OpeningGuideView | null,
  engineNote: string | null,
): GistLines {
  const facts = boardFacts(chess);
  const material = materialNote(chess);
  const space = spaceNote(chess);
  const balance = balanceLine(engine, material, space, facts.centralWedge, engineNote);
  const plans = planLines(guide, facts, chess);
  return {
    balance,
    whitePlan: plans.white,
    blackPlan: plans.black,
    watch: watchLine(chess, facts),
    bestMove: bestMoveLine(chess.fen(), engine),
  };
}

function gistSource(engine: EngineResult | null): PositionGist["source"] {
  if (engine?.terminal) return "engine-checked";
  if (engine?.coverage === "evaluated" && engine.score) return "engine-checked";
  return "provisional";
}

function balanceLine(
  engine: EngineResult | null,
  material: string | null,
  space: string | null,
  wedge: boolean,
  engineNote: string | null,
): string {
  const why = [material, space, wedge ? "The center is a closed pawn wedge." : null].filter(Boolean).join(" ");
  if (engine?.terminal) {
    return `${engine.scoreWhiteLabel}. That is the rules of the position, not a model guess.`;
  }
  if (engine?.coverage === "cooling-down") {
    return `The engine is cooling down. Try again in about a minute. Who is better stays provisional. ${why}`.trim();
  }
  if (engine?.coverage === "timeout") {
    return `The cloud evaluation timed out. Who is better stays provisional. ${why}`.trim();
  }
  if (engine?.coverage === "evaluated" && engine.score) {
    return `${evalWords(engine.score)} (engine-checked, ${engine.scoreWhiteLabel}). ${why}`.trim();
  }
  const missing = engineNote
    ? engineNote
    : "No stored cloud evaluation, so who is better stays provisional.";
  return `${missing} ${why}`.trim();
}

function planLines(
  guide: OpeningGuideView | null,
  facts: ReturnType<typeof boardFacts>,
  chess: Chess,
): { white: string; black: string } {
  if (guide) {
    const prefix = "Curated opening note, not engine-checked.";
    return {
      white: `${prefix} ${guide.whitePlans}`,
      black: `${prefix} ${guide.blackPlans}`,
    };
  }
  const early = Number(chess.fen().split(" ")[5] || 1) <= 10 && !facts.centralWedge;
  if (early) {
    return {
      white: "No opening guide matched. A practical provisional plan is to develop the minor pieces and castle before sending the queen out.",
      black: "No opening guide matched. A practical provisional plan is to develop the minor pieces and castle before opening the position.",
    };
  }
  return {
    white: facts.centralWedge
      ? "The center is closed. A provisional plan is play on a wing, not a pawn break that is not prepared."
      : "No opening guide matched, and no cloud line names a plan. White's plan stays provisional.",
    black: facts.centralWedge
      ? "The center is closed. A provisional plan is to prepare a break rather than force one."
      : "No opening guide matched, and no cloud line names a plan. Black's plan stays provisional.",
  };
}

function watchLine(chess: Chess, facts: ReturnType<typeof boardFacts>): string {
  const bits: string[] = [];
  if (facts.checkmate) bits.push(`${facts.sideToMove === "white" ? "White" : "Black"} to move is checkmated.`);
  else if (facts.inCheck) bits.push(`${facts.sideToMove === "white" ? "White" : "Black"} is in check.`);
  else if (facts.stalemate) bits.push("The position is stalemate.");
  bits.push(...looseCaptures(chess).slice(0, 2));
  bits.push(...structureNotes(chess).slice(0, 2));
  if (!bits.length) bits.push("No hanging piece showed up on a simple count. That is not a full tactical search.");
  return bits.join(" ");
}

function bestMoveLine(fen: string, engine: EngineResult | null): string {
  if (!engine || engine.coverage !== "evaluated" || !engine.bestMoveSan) {
    return "No stored best move for this position. This part is provisional.";
  }
  return `${engine.bestMoveSan} ${moveIdea(fen, engine.bestMoveSan)} (engine-checked).`;
}

export function moveIdea(fen: string, san: string): string {
  const chess = new Chess(fen);
  let move;
  try {
    move = chess.move(san);
  } catch {
    move = null;
  }
  if (!move) return "is the stored first move";
  if (san.startsWith("O-O")) return "castles the king";
  const verbs: string[] = [];
  if (move.captured) verbs.push(`captures the ${WORD[move.captured] ?? "piece"} on ${move.to}`);
  else if (move.piece === "p") verbs.push("pushes the pawn");
  else if (move.from[1] === "1" || move.from[1] === "8") verbs.push("develops");
  else verbs.push(`moves to ${move.to}`);
  if (move.piece === "n") {
    const eyes = knightAttacksFrom(chess, move.to).filter((square) => "cdef".includes(square[0]) && "3456".includes(square[1]));
    if (eyes[0]) verbs.push(`eyes ${eyes[0]}`);
  }
  if (chess.isCheck()) verbs.push("gives check");
  return verbs.join(" and ");
}

function looseCaptures(chess: Chess): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const move of chess.moves({ verbose: true })) {
    if (!move.captured || seen.has(move.to)) continue;
    const copy = new Chess(chess.fen());
    copy.move(move.san);
    const recaptured = copy.moves({ verbose: true }).some((reply) => reply.to === move.to && reply.captured);
    if (recaptured) continue;
    seen.add(move.to);
    const side = move.color === "w" ? "White" : "Black";
    notes.push(`${side} can take the ${WORD[move.captured] ?? "piece"} on ${move.to} with ${move.san}, and nothing recaptures on that square.`);
  }
  return notes;
}

function structureNotes(chess: Chess): string[] {
  const facts = boardFacts(chess);
  const notes: string[] = [];
  if (facts.centralWedge) notes.push("The d- and e-file pawns block each other.");
  for (const color of ["w", "b"] as const) {
    const list = color === "w" ? facts.whitePawns : facts.blackPawns;
    const files = list.map((square) => square[0]);
    const doubled = [...new Set(files.filter((file, index) => files.indexOf(file) !== index))];
    if (doubled.length) {
      notes.push(`${color === "w" ? "White" : "Black"} has doubled pawns on the ${doubled.join(" and ")}-file.`);
    }
  }
  return notes;
}

function materialNote(chess: Chess): string | null {
  let diff = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = VALUE[piece.type] ?? 0;
      diff += piece.color === "w" ? value : -value;
    }
  }
  if (diff === 0) return null;
  const side = diff > 0 ? "White" : "Black";
  const pawns = Math.abs(diff);
  if (pawns === 1) return `${side} is ahead by a pawn on the piece count.`;
  return `${side} is ahead by about ${pawns} pawns on the piece count.`;
}

function spaceNote(chess: Chess): string | null {
  const facts = boardFacts(chess);
  let white = 0;
  let black = 0;
  for (const square of facts.whitePawns) {
    if ("cdef".includes(square[0]) && Number(square[1]) >= 4) white += 1;
  }
  for (const square of facts.blackPawns) {
    if ("cdef".includes(square[0]) && Number(square[1]) <= 5) black += 1;
  }
  if (white >= black + 2) return "White has more space in the center.";
  if (black >= white + 2) return "Black has more space in the center.";
  return null;
}

function joinLines(lines: GistLines): string {
  return [
    lines.balance,
    `White: ${lines.whitePlan}`,
    `Black: ${lines.blackPlan}`,
    `Watch: ${lines.watch}`,
    `Best move: ${lines.bestMove}`,
  ].join("\n");
}

async function phraseLines(
  lines: GistLines,
  source: PositionGist["source"],
  provider: LlmProvider,
  signal?: AbortSignal,
): Promise<{ lines: GistLines; phrasing: PositionGist["phrasing"]; modelNote?: string }> {
  const availability = await provider.available();
  if (!availability.ok) {
    return { lines, phrasing: "facts-only", modelNote: availability.reason };
  }
  try {
    const text = await provider.complete(
      [
        {
          role: "system",
          content:
            "You phrase a chess gist from the supplied lines only. Do not add an evaluation, a tactic, a piece, or a move that is not already in the lines. Keep engine-checked and provisional labels. Return JSON only: {\"balance\":\"\",\"whitePlan\":\"\",\"blackPlan\":\"\",\"watch\":\"\",\"bestMove\":\"\"}.",
        },
        { role: "user", content: JSON.stringify({ source, lines }) },
      ],
      { purpose: "explain", signal },
    );
    const parsed = parseGistJson(text);
    if (!parsed) return { lines, phrasing: "facts-only", modelNote: "The model reply was not usable, so this gist stays facts-only." };
    return { lines: acceptPhrasing(lines, parsed, source), phrasing: "model" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      lines,
      phrasing: "facts-only",
      modelNote: error instanceof Error ? error.message : "The model did not answer, so this gist stays facts-only.",
    };
  }
}

export function acceptPhrasing(lines: GistLines, model: Partial<GistLines>, source: PositionGist["source"]): GistLines {
  const allowed = joinLines(lines);
  const keep = (field: keyof GistLines, extra?: (value: string) => boolean) => {
    const value = model[field]?.trim();
    if (!value || inventedNumber(value, allowed) || inventedSan(value, allowed)) return lines[field];
    if (extra && !extra(value)) return lines[field];
    return value;
  };
  return {
    balance: keep("balance", (value) => (source === "engine-checked" ? /engine-checked|rules of the position/i.test(value) : /provisional|cooling down|timed out|no stored/i.test(value))),
    whitePlan: keep("whitePlan"),
    blackPlan: keep("blackPlan"),
    watch: keep("watch"),
    bestMove: keep("bestMove", (value) => {
      const san = lines.bestMove.split(" ")[0];
      if (san.startsWith("No")) return /provisional|no stored/i.test(value);
      return value.includes(san);
    }),
  };
}

function inventedNumber(value: string, allowed: string): boolean {
  const numbers = value.match(/\d+(?:\.\d+)?/g) ?? [];
  return numbers.some((number) => !allowed.includes(number));
}

function inventedSan(value: string, allowed: string): boolean {
  const tokens = value.match(/\b(?:O-O-O|O-O|[NBRQK]?[a-h]x[a-h][1-8]|[NBRQK][a-h][1-8])\b/g) ?? [];
  return tokens.some((token) => !allowed.includes(token));
}

function parseGistJson(text: string): Partial<GistLines> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<GistLines>;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
