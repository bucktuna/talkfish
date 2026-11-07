import { Chess, type Square } from "chess.js";

export type BoardFacts = {
  sideToMove: "white" | "black";
  inCheck: boolean;
  checkmate: boolean;
  stalemate: boolean;
  draw: boolean;
  legalMoveCount: number;
  centralWedge: boolean;
  whitePawns: string[];
  blackPawns: string[];
};

export function boardFacts(chess: Chess): BoardFacts {
  return {
    sideToMove: chess.turn() === "w" ? "white" : "black",
    inCheck: chess.isCheck(),
    checkmate: chess.isCheckmate(),
    stalemate: chess.isStalemate(),
    draw: chess.isDraw(),
    legalMoveCount: chess.moves().length,
    centralWedge: hasCentralWedge(chess),
    whitePawns: pawns(chess, "w"),
    blackPawns: pawns(chess, "b"),
  };
}

function pawns(chess: Chess, color: "w" | "b"): string[] {
  const squares: string[] = [];
  for (const file of "abcdefgh") {
    for (let rank = 1; rank <= 8; rank += 1) {
      const square = `${file}${rank}` as Square;
      const piece = chess.get(square);
      if (piece?.type === "p" && piece.color === color) squares.push(square);
    }
  }
  return squares;
}

export function hasCentralWedge(chess: Chess): boolean {
  return ["d", "e"].every((file) => fileHasBlockedPawns(chess, file));
}

function fileHasBlockedPawns(chess: Chess, file: string): boolean {
  for (let rank = 2; rank <= 7; rank += 1) {
    const here = chess.get(`${file}${rank}` as Square);
    const above = chess.get(`${file}${rank + 1}` as Square);
    if (here?.type === "p" && above?.type === "p" && here.color !== above.color) return true;
  }
  return false;
}

export function pieceOn(
  chess: Chess,
  square: string,
  color: "w" | "b",
  piece: "p" | "n" | "b" | "r" | "q" | "k",
): boolean {
  const found = chess.get(square as Square);
  return Boolean(found && found.color === color && found.type === piece);
}

export function isLegalSan(chess: Chess, san: string): boolean {
  const copy = new Chess(chess.fen());
  try {
    return Boolean(copy.move(san));
  } catch {
    return false;
  }
}

export function sanToUci(fen: string, san: string): { san: string; uci: string; from: string; to: string } | null {
  const copy = new Chess(fen);
  try {
    const move = copy.move(san);
    if (!move) return null;
    return {
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      from: move.from,
      to: move.to,
    };
  } catch {
    return null;
  }
}

export function knightAttacksFrom(chess: Chess, square: string): string[] {
  const piece = chess.get(square as Square);
  if (!piece || piece.type !== "n") return [];
  const files = "abcdefgh";
  const file = files.indexOf(square[0]);
  const rank = Number(square[1]);
  const jumps = [
    [1, 2],
    [2, 1],
    [2, -1],
    [1, -2],
    [-1, -2],
    [-2, -1],
    [-2, 1],
    [-1, 2],
  ];
  const attacked: string[] = [];
  for (const [df, dr] of jumps) {
    const nextFile = file + df;
    const nextRank = rank + dr;
    if (nextFile < 0 || nextFile > 7 || nextRank < 1 || nextRank > 8) continue;
    attacked.push(`${files[nextFile]}${nextRank}`);
  }
  return attacked;
}
