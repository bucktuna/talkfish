import { randomBytes } from "node:crypto";
import { Chess, type Square } from "chess.js";
import { pieceOn, sanToUci } from "@/lib/board-facts";
import { positionKeyFromFen } from "@/lib/fen";
import { analyzeFen } from "@/lib/engine";
import { HttpError } from "@/lib/http/errors";
import { addEvent, addRevision, listEvents, sha256, type Revision } from "@/lib/store";
import type { Claim } from "@/lib/types";

const PII = [
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
  /\b(?:password|api[_-]?key|secret|bearer)\b/i,
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  /(?:^|\n)\s*(?:user|coach|assistant)\s*:/i,
];

export type SubmissionClaim = {
  text: string;
  assertion?: "best-move" | "legal-move" | "piece-on";
  san?: string;
  square?: string;
  piece?: "p" | "n" | "b" | "r" | "q" | "k";
  color?: "w" | "b";
};

export function quarantineReason(text: string): string | null {
  if (text.length > 4000) return "The explanation is too long.";
  for (const pattern of PII) {
    if (pattern.test(text)) {
      return "The text looks like private data or a conversation transcript. It was quarantined for review and was not published. Pattern checks are not a guarantee that every private detail is found.";
    }
  }
  return null;
}

export async function createContribution(input: {
  authorId: string;
  fen: string;
  explanation: string;
  claims?: SubmissionClaim[];
}): Promise<Revision> {
  let chess: Chess;
  try {
    chess = new Chess(input.fen);
  } catch {
    throw new HttpError(400, "That FEN is not legal.");
  }
  const fen = chess.fen();
  const positionKey = positionKeyFromFen(fen);
  const explanation = input.explanation.trim();
  if (!explanation) throw new HttpError(400, "Write the chess explanation to submit.");
  const held = quarantineReason(explanation);
  const claims: Claim[] = [];
  let confirmedSan: string | null = null;

  for (const claim of input.claims ?? []) {
    if (claim.assertion === "piece-on") {
      if (!claim.square || !claim.piece || !claim.color) {
        throw new HttpError(400, "A piece-on claim needs a square, piece, and color.");
      }
      const ok = pieceOn(chess, claim.square, claim.color, claim.piece);
      claims.push({
        id: `piece-${claim.square}`,
        text: claim.text,
        status: ok ? "mapped" : "open",
        kind: "board",
        reason: ok ? "Checked against this FEN." : "The piece is not on that square, so the claim stays open.",
        evidence: ok ? [`${claim.color}${claim.piece} on ${claim.square}`] : ["Board check failed."],
      });
    } else if (claim.assertion === "legal-move" || claim.assertion === "best-move") {
      if (!claim.san) throw new HttpError(400, "Name the move to check.");
      const played = sanToUci(fen, claim.san);
      if (!played) throw new HttpError(400, `${claim.san} is not a legal move in this position.`);
      if (claim.assertion === "legal-move") {
        claims.push({
          id: `legal-${played.san}`,
          text: claim.text,
          status: "mapped",
          kind: "board",
          reason: "The move is legal in this position. Legality is not a plan.",
          evidence: [played.uci],
        });
      } else {
        confirmedSan = played.san;
      }
    } else {
      claims.push({
        id: `prose-${claims.length + 1}`,
        text: claim.text,
        status: "open",
        kind: "strategic",
        reason: "Unverified contributor prose stays open. It is not part of the trusted baseline.",
        evidence: [],
      });
    }
  }

  if (!held && confirmedSan) {
    const depth = Number(process.env.CONTRIBUTION_SEARCH_DEPTH || 6);
    const engine = await analyzeFen(fen, { depth, movetimeMs: 500 });
    const matches = engine.bestMoveSan === confirmedSan && engine.pvLegal;
    claims.push({
      id: "contributor-search",
      text: `Contributor named ${confirmedSan}. This server's search at depth ${engine.depth} ended on ${engine.bestMoveSan ?? "no move"} with ${engine.scoreWhiteLabel}.`,
      status: matches ? "mapped" : "open",
      kind: "engine-report",
      reason: matches
        ? "The named move matched this server's own search. That is a search report, not proof of a plan."
        : "The named move did not match this server's search, so it stays open.",
      evidence: [`${engine.engineName}`, `depth ${engine.depth}`, engine.bestMove ?? "none"],
    });
    if (matches) {
      const dedupeKey = `${positionKey}|${confirmedSan}`;
      const events = await listEvents();
      const already = events.some(
        (event) => event.type === "engine-confirmed" && event.accountId === input.authorId && event.dedupeKey === dedupeKey,
      );
      if (!already) {
        await addEvent({
          type: "engine-confirmed",
          accountId: input.authorId,
          dedupeKey,
          note: "Matched a server search. Duplicate submissions of the same move in the same position do not count again.",
        });
      }
    }
  }

  if (claims.length === 0) {
    claims.push({
      id: "pending-prose",
      text: "This explanation is pending review. It is not a trusted baseline.",
      status: "open",
      kind: "strategic",
      reason: "A new submission is not mapped just because an account sent it.",
      evidence: [],
    });
  }

  const revision: Revision = {
    id: randomBytes(8).toString("hex"),
    authorId: input.authorId,
    positionKey,
    fen,
    explanation: held ? explanation : explanation,
    claims,
    contentHash: sha256(`${positionKey}\n${explanation}\n${claims.map((claim) => claim.text).join("\n")}`),
    status: held ? "quarantined" : "pending",
    reviewFlag: Boolean(held),
    createdAt: new Date().toISOString(),
    quarantineReason: held ?? undefined,
  };
  await addRevision(revision);
  return revision;
}

export function squareOf(value: string): Square {
  return value as Square;
}
