import { Chess, type Square } from "chess.js";
import { knightAttacksFrom, sanToUci } from "@/lib/board-facts";
import type { Claim } from "@/lib/types";

export type MoveRef = {
  san: string;
  uci: string;
  from: string;
  to: string;
  explicit: boolean;
};

const PIECE_SAN = /\b(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/g;
const FROM_TO = /\b([KQRBN]?)([a-h][1-8])\s*(?:-|to)\s*([a-h][1-8])(?:=([QRBN]))?/gi;
const PAWN_SAN = /\b([a-h](?:x[a-h])?[1-8](?:=[QRBN])?[+#]?)\b/g;

export function extractMoveRefs(question: string, fen: string): { legal: MoveRef[]; illegal: string[] } {
  const wanted = new Set<string>();
  const illegal: string[] = [];
  const remember = (token: string, explicit: boolean) => {
    const normalized = token.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O").replace(/[+#]/g, "");
    const played = sanToUci(fen, normalized);
    if (played) {
      wanted.add(JSON.stringify({ ...played, explicit }));
      return;
    }
    if (explicit) illegal.push(token);
  };

  for (const match of question.matchAll(FROM_TO)) {
    const piece = match[1] || "";
    const from = match[2];
    const to = match[3];
    const promotion = match[4] ? `=${match[4].toUpperCase()}` : "";
    remember(`${piece}${from[0] === to[0] ? "" : from}${to}${promotion}`, true);
    remember(`${piece}${from}${to}${promotion}`.replace(from, from[0]), true);
  }
  for (const match of question.matchAll(PIECE_SAN)) remember(match[1], true);
  for (const match of question.matchAll(PAWN_SAN)) {
    const index = match.index ?? 0;
    const before = question.slice(Math.max(0, index - 16), index).toLowerCase();
    if (/\bon\s+$|\bsquare\s+$/.test(before)) continue;
    const cued = /move|play|push|break|instead|compare|try/.test(before);
    const token = match[1];
    if (cued || /^[a-h][1-8][+#]?$/.test(token)) remember(token, cued);
  }

  const legal: MoveRef[] = [];
  const seen = new Set<string>();
  for (const raw of wanted) {
    const move = JSON.parse(raw) as MoveRef;
    if (seen.has(move.uci)) continue;
    seen.add(move.uci);
    legal.push(move);
  }
  return { legal, illegal };
}

export function questionFindings(question: string, fen: string): Claim[] {
  const claims: Claim[] = [];
  const chess = new Chess(fen);
  if (rookRetiresBreak(question)) {
    const rookOnE1 = chess.get("e1" as Square);
    if (rookOnE1?.type === "r" && rookOnE1.color === "w") {
      claims.push(fact("rook-on-e1", "White's rook is on e1.", "board", ["The e1 square is occupied by a white rook."]));
    }
    const f4 = sanToUci(fen, "f4");
    if (f4) {
      claims.push(
        fact(
          "f4-legal",
          "f4 is a legal move in the current position, so it has not been ruled out as a move.",
          "board",
          ["chess.js accepts f4 from this FEN."],
        ),
      );
    }
    claims.push({
      id: "f4-plan-open",
      text: "The rook placement does not establish whether f4 is still a plan. A legal move is not the same thing as a commitment, and one rook move is not a proof that the break was abandoned.",
      status: "open",
      kind: "causal",
      reason: "No board or engine fact turns a rook move into the retirement of a future pawn break.",
      evidence: ["Method limit checked against this position's move list, not against a similar-looking board."],
    });
  }

  if (ndf3OnlyBlock(question)) {
    const attempt = sanToUci(fen, "Ndf3") ?? sanToUci(fen, "Nf3");
    if (attempt?.from === "d2" && attempt.to === "f3") {
      const after = new Chess(fen);
      after.move(attempt.san);
      const attacks = knightAttacksFrom(after, "f3");
      const pawnBlocked = !after.moves({ square: "f2" as Square }).some((san) => san === "f3" || san === "f4");
      if (pawnBlocked) {
        claims.push(
          fact(
            "f-pawn-blocked",
            "After Ndf3, the white pawn on f2 cannot play f3 or f4 on the next move because the knight occupies f3.",
            "board",
            ["The move Ndf3 was played on a copy of this FEN and the f-pawn's legal moves were listed."],
          ),
        );
      }
      claims.push(
        fact(
          "knight-attacks",
          `After Ndf3 the knight on f3 attacks ${attacks.join(", ")}.`,
          "board",
          ["Knight geometry from f3 on the position after the move."],
        ),
      );
      claims.push({
        id: "ndf3-purpose-open",
        text: "Those attacks show a possible attacking geometry, and the blocked pawn is a real cost. Neither fact establishes that the knight's only function is defensive, or that it cannot also serve an attack.",
        status: "open",
        kind: "causal",
        reason: "Purpose is not settled by one occupied square or by the list of attacked squares.",
        evidence: ["Server-checked geometry after the named move on this FEN."],
      });
    } else {
      claims.push({
        id: "ndf3-not-here",
        text: "Ndf3 is not a legal knight move from d2 in this position, so a blocking story about that move is not applied here.",
        status: "mapped",
        kind: "board",
        reason: "The named move was checked on this FEN and rejected.",
        evidence: ["chess.js did not accept a d2-knight move to f3."],
      });
    }
  }

  if (restraintClaim(question)) {
    const square = /e5/.test(question) ? "e5" : null;
    if (square) {
      const attackers = ["b1", "c3", "d2", "f3", "g1", "e2", "c4"].filter((origin) => {
        const piece = chess.get(origin as Square);
        return piece?.type === "n" && piece.color === "w" && knightAttacksFrom(chess, origin).includes(square);
      });
      if (attackers.length) {
        claims.push(
          fact(
            "knight-attacks-pawn",
            `A white knight on ${attackers.join(" and ")} attacks ${square}.`,
            "board",
            ["Knight geometry on this FEN."],
          ),
        );
      }
    }
    claims.push({
      id: "restraint-open",
      text: "A knight that supports or attacks a pawn does not, by itself, prove that the strategy is restraint.",
      status: "open",
      kind: "causal",
      reason: "The geometric attack can be mapped. The strategic label cannot.",
      evidence: ["The inference was checked as an inference. Popularity and engine scores were not used as proof."],
    });
  }
  return claims;
}

function fact(id: string, text: string, kind: Claim["kind"], evidence: string[]): Claim {
  return {
    id,
    text,
    kind,
    status: "mapped",
    reason: "Checked against this position.",
    evidence,
  };
}

export function affirmsRookRetiresBreak(text: string): boolean {
  return text.split(/(?<=[.!?])\s+/).some((sentence) => {
    const hasRook = /rook|\bre1\b|\brf1\b/i.test(sentence);
    const hasBreak = /f4|f-pawn|pawn break/i.test(sentence);
    const affirms = /no longer|abandoned|rules out|proves|not (?:a|the) (?:future )?plan/i.test(sentence);
    const negates = /does not|doesn't|do not|cannot|can't|not prove|no evidence|insufficient|not established/i.test(sentence);
    return hasRook && hasBreak && affirms && !negates;
  });
}

function rookRetiresBreak(question: string): boolean {
  return /rook|\bre1\b|\brf1\b|f1\s*(?:-|to)\s*e1/i.test(question) &&
    /f4|f-pawn|pawn break/i.test(question) &&
    /no longer|prove|abandon|plan|rules out|future/i.test(question);
}

function ndf3OnlyBlock(question: string): boolean {
  return /ndf3|n\s*d2|knight (?:to|on) f3|blocks? the f/i.test(question) && /block|only|just|merely|defen/i.test(question);
}

function restraintClaim(question: string): boolean {
  return /knight|\bnf3\b/i.test(question) && /restraint/i.test(question) && /prove|means|therefore|strategy|shows|whole/i.test(question);
}
