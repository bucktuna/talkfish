import { Chess, validateFen } from "chess.js";

export class FenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FenError";
  }
}

export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function positionKeyFromFen(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

export function normalizeWhitespace(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/** Four fields keep turn, castling, and en passant. Only the two clocks are filled. */
export function expandFenFields(text: string): { fen: string; notice?: string } {
  const parts = text.trim().replace(/[ \t]+/g, " ").split(" ");
  if (parts.length === 4) {
    return {
      fen: `${parts.join(" ")} 0 1`,
      notice:
        "Halfmove clock and fullmove number were omitted, so they default to 0 and 1. Turn, castling, and en passant were taken from the text and not invented.",
    };
  }
  if (parts.length !== 6) {
    throw new FenError(
      "A FEN needs 4 fields (placement, side to move, castling, en passant) or 6 fields including the halfmove clock and fullmove number.",
    );
  }
  return { fen: parts.join(" ") };
}

export function loadFen(raw: string): {
  chess: Chess;
  fen: string;
  positionKey: string;
  notices: string[];
} {
  const notices: string[] = [];
  const cleaned = normalizeWhitespace(raw);
  if (!cleaned) throw new FenError("Paste a FEN or a PGN first.");
  if (cleaned.length > 200) throw new FenError("That FEN is too long.");
  if (cleaned.includes("\n")) {
    throw new FenError("That text has more than one line, so it was not read as a FEN.");
  }
  const expanded = expandFenFields(cleaned);
  if (expanded.notice) notices.push(expanded.notice);
  const validation = validateFen(expanded.fen);
  if (!validation.ok) {
    throw new FenError(validation.error || "That FEN is not legal.");
  }
  let chess: Chess;
  try {
    chess = new Chess(expanded.fen);
  } catch (error) {
    throw new FenError(error instanceof Error ? error.message : "That FEN is not legal.");
  }
  const canonical = chess.fen();
  const askedEp = expanded.fen.split(" ")[3];
  const canonicalEp = canonical.split(" ")[3];
  if (askedEp !== canonicalEp) {
    notices.push(
      `En passant square ${askedEp} is not a legal capture, so the canonical position records ${canonicalEp}.`,
    );
  }
  return {
    chess,
    fen: canonical,
    positionKey: positionKeyFromFen(canonical),
    notices,
  };
}

export function sideToMoveLabel(fen: string): "White" | "Black" {
  return fen.split(" ")[1] === "b" ? "Black" : "White";
}
