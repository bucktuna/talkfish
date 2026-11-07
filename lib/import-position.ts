import { Chess } from "chess.js";
import { FenError, START_FEN, loadFen, normalizeWhitespace, positionKeyFromFen } from "@/lib/fen";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export type ImportedLine = {
  format: "fen" | "pgn";
  startFen: string;
  fens: string[];
  sans: string[];
  tags: Record<string, string>;
  notices: string[];
  positionKey: string;
  finalFen: string;
};

const MAX_PGN_CHARS = 100_000;

export function importPosition(raw: string): ImportedLine {
  const text = normalizeWhitespace(raw);
  if (!text) throw new ImportError("Paste a FEN or a PGN first.");
  if (text.length > MAX_PGN_CHARS) {
    throw new ImportError("That import is too long.");
  }
  const format = detectFormat(text);
  if (format === "fen") {
    try {
      const loaded = loadFen(text.replace(/\n+/g, " ").trim());
      return {
        format: "fen",
        startFen: loaded.fen,
        fens: [loaded.fen],
        sans: [],
        tags: {},
        notices: loaded.notices,
        positionKey: loaded.positionKey,
        finalFen: loaded.fen,
      };
    } catch (error) {
      if (error instanceof FenError || error instanceof ImportError) throw error;
      throw new ImportError(error instanceof Error ? error.message : "Could not read that FEN.");
    }
  }
  return importPgn(text);
}

export function detectFormat(text: string): "fen" | "pgn" {
  const firstContent =
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  if (firstContent.startsWith("[")) return "pgn";
  const oneLine = text.replace(/\s+/g, " ").trim();
  const parts = oneLine.split(" ");
  if ((parts.length === 4 || parts.length === 6) && parts[0].includes("/")) return "fen";
  if (/^(?:\d+\.|[KQRBN]?[a-h]|O-O|0-0)/.test(firstContent)) return "pgn";
  throw new ImportError("Paste a FEN or one PGN game. The format was not recognized.");
}

function importPgn(text: string): ImportedLine {
  const notices: string[] = [];
  const tagBlocks = countTagBlocks(text);
  if (tagBlocks > 1) {
    throw new ImportError(
      "This paste contains more than one game. Load a single game. Nothing was changed on the board.",
    );
  }
  if (hasSideVariation(text)) {
    notices.push(
      "Side variations were not loaded. The board follows the main line only and does not mix in the parenthetical lines.",
    );
  }
  if (hasComment(text)) {
    notices.push("PGN comments were not played and are not sent to the coach as move narration.");
  }
  if (/0-0/.test(stripCommentsAndTags(text))) {
    notices.push("Castling written as 0-0 or 0-0-0 was accepted as O-O or O-O-O.");
  }

  const chess = new Chess();
  const playable = normalizeCastlingOutsideAnnotations(text);
  try {
    chess.loadPgn(playable, { strict: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Invalid PGN";
    if (/Expected end of input|multiple/i.test(detail)) {
      throw new ImportError(
        "This paste contains more than one game. Load a single game. Nothing was changed on the board.",
      );
    }
    throw new ImportError(
      `Could not load that PGN (${detail}). Illegal or malformed moves are not skipped. Nothing was changed on the board.`,
    );
  }

  const tags = chess.getHeaders();
  const essential = ["Event", "White", "Black", "Result", "SetUp", "FEN"].filter((key) => tags[key]);
  if (essential.length) {
    notices.push(`Tags kept: ${essential.join(", ")}.`);
  }
  if (tags.FEN && tags.SetUp !== "1") {
    notices.push(
      'A FEN tag is present without [SetUp "1"], so the standard starting position was used. Add the SetUp tag if that FEN should be the start.',
    );
  }
  if (tags.SetUp === "1" && tags.FEN) {
    notices.push("The game starts from the FEN tag because SetUp is 1.");
  }

  const startFen = tags.SetUp === "1" && tags.FEN ? new Chess(tags.FEN).fen() : START_FEN;
  const replay = new Chess(startFen);
  const sans = chess.history();
  const fens = [replay.fen()];
  for (const san of sans) {
    const move = replay.move(san);
    if (!move) {
      throw new ImportError(
        `The main line contains an illegal move (${san}). Nothing was changed on the board.`,
      );
    }
    fens.push(replay.fen());
  }
  const finalFen = fens[fens.length - 1];
  return {
    format: "pgn",
    startFen,
    fens,
    sans,
    tags,
    notices,
    positionKey: positionKeyFromFen(finalFen),
    finalFen,
  };
}

function normalizeCastlingOutsideAnnotations(pgn: string): string {
  let out = "";
  let i = 0;
  while (i < pgn.length) {
    const ch = pgn[i];
    if (ch === "{" || ch === "[") {
      const end = ch === "{" ? "}" : "]";
      const close = pgn.indexOf(end, i + 1);
      const stop = close === -1 ? pgn.length : close + 1;
      out += pgn.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === ";") {
      const close = pgn.indexOf("\n", i);
      const stop = close === -1 ? pgn.length : close;
      out += pgn.slice(i, stop);
      i = stop;
      continue;
    }
    if (pgn.startsWith("0-0-0", i)) {
      out += "O-O-O";
      i += 5;
      continue;
    }
    if (pgn.startsWith("0-0", i)) {
      out += "O-O";
      i += 3;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function countTagBlocks(text: string): number {
  let blocks = 0;
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) {
      if (!inBlock) {
        blocks += 1;
        inBlock = true;
      }
    } else if (line.trim()) {
      inBlock = false;
    }
  }
  return blocks;
}

function hasSideVariation(pgn: string): boolean {
  let i = 0;
  while (i < pgn.length) {
    const ch = pgn[i];
    if (ch === "{") {
      while (i < pgn.length && pgn[i] !== "}") i += 1;
      i += 1;
      continue;
    }
    if (ch === ";") {
      while (i < pgn.length && pgn[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "[") {
      while (i < pgn.length && pgn[i] !== "]") i += 1;
      i += 1;
      continue;
    }
    if (ch === "(") return true;
    i += 1;
  }
  return false;
}

function hasComment(pgn: string): boolean {
  let i = 0;
  while (i < pgn.length) {
    const ch = pgn[i];
    if (ch === "[") {
      while (i < pgn.length && pgn[i] !== "]") i += 1;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === ";") return true;
    i += 1;
  }
  return false;
}

function stripCommentsAndTags(pgn: string): string {
  let out = "";
  let i = 0;
  while (i < pgn.length) {
    const ch = pgn[i];
    if (ch === "{") {
      while (i < pgn.length && pgn[i] !== "}") i += 1;
      i += 1;
      continue;
    }
    if (ch === ";") {
      while (i < pgn.length && pgn[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "[") {
      while (i < pgn.length && pgn[i] !== "]") i += 1;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function fenAtCursor(line: Pick<ImportedLine, "fens">, cursor: number): string {
  const index = Math.max(0, Math.min(cursor, line.fens.length - 1));
  return line.fens[index];
}
