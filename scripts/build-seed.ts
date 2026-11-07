import { writeFileSync } from "node:fs";
import { analyzeFen } from "../lib/engine";
import { positionKeyFromFen } from "../lib/fen";
import { CLOSED_CENTER_FEN, OPEN_GAME_FEN } from "../lib/samples";
import type { EngineResult } from "../lib/types";

const version = "0.1.0";

function engineBlock(result: EngineResult) {
  return {
    name: result.engineName,
    depth: result.depth,
    bestMove: result.bestMove,
    bestMoveSan: result.bestMoveSan,
    scoreWhiteCp: result.score?.kind === "cp" ? result.score.value : null,
    scoreWhiteMate: result.score?.kind === "mate" ? result.score.value : null,
    scoreWhiteLabel: result.scoreWhiteLabel,
    pv: result.pv,
    pvSan: result.pvSan,
    stable: result.stable,
  };
}

async function main() {
  const limits = { depth: 12, movetimeMs: 2500 };
  const open = await analyzeFen(OPEN_GAME_FEN, limits);
  const closed = await analyzeFen(CLOSED_CENTER_FEN, limits);
  if (!open.bestMove || !closed.bestMove) throw new Error("Seed search returned no move.");
  const doc = {
    version,
    positions: [
      {
        id: "open-game",
        revisionId: "seed-open-game",
        positionKey: positionKeyFromFen(OPEN_GAME_FEN),
        fen: OPEN_GAME_FEN,
        themes: ["open-game"],
        explanation:
          "White is to move in an open game, with a knight on f3 and a pawn on e4. The search report below is one Stockfish run. Which plan a developing move serves is provisional, not a proof.",
        claims: [
          {
            id: "nf3-on-board",
            text: "White's knight is on f3.",
            kind: "board",
            status: "mapped",
            reason: "Checked against the piece placement.",
            evidence: ["white knight on f3"],
            check: { type: "pieceOn", square: "f3", color: "w", piece: "n" },
          },
          {
            id: "open-search",
            text: `Stored ${open.engineName} search at depth ${open.depth} ended on ${open.bestMoveSan}, ${open.scoreWhiteLabel}.`,
            kind: "engine-report",
            status: "mapped",
            reason: "The stored PV was replayed. This reports that search and does not prove a unique plan.",
            evidence: [`depth ${open.depth}`, open.bestMove],
            check: { type: "storedSearch", bestMove: open.bestMove, minDepth: 8 },
          },
          {
            id: "open-preference",
            text: `Engine preference in the stored search: ${open.bestMoveSan}.`,
            kind: "engine-preference",
            status: "provisional",
            reason: "A finite search preference is not an explanation.",
            evidence: [`depth ${open.depth}`],
          },
          {
            id: "open-plan",
            text: "Developing a piece is a normal candidate. Which plan it serves is not settled by one line.",
            kind: "strategic",
            status: "provisional",
            reason: "Strategic reading. A seed file does not make this mapped.",
            evidence: ["Maintainer-written hypothesis, not an engine cause."],
          },
        ],
        engine: engineBlock(open),
        provenance: {
          source: "maintainer-seed",
          corpusVersion: version,
          note: "Board checks are re-run on load. The search report stays mapped only while it still matches the stored PV.",
        },
      },
      {
        id: "closed-center",
        revisionId: "seed-closed-center",
        positionKey: positionKeyFromFen(CLOSED_CENTER_FEN),
        fen: CLOSED_CENTER_FEN,
        themes: ["closed-center"],
        explanation:
          "White is to move against a closed central wedge: pawns on d4 and e5 face black pawns on d5 and e6. The rook on e1 sits behind that wedge. f4 is still a legal move, so the rook's square does not retire that break. Whether f4 belongs in the plan is open.",
        claims: [
          {
            id: "rook-e1",
            text: "White's rook is on e1.",
            kind: "board",
            status: "mapped",
            reason: "Checked against the piece placement.",
            evidence: ["white rook on e1"],
            check: { type: "pieceOn", square: "e1", color: "w", piece: "r" },
          },
          {
            id: "wedge",
            text: "The d- and e-file pawns block each other.",
            kind: "board",
            status: "mapped",
            reason: "Both central files have opposing pawns on adjacent ranks.",
            evidence: ["d4/d5 and e5/e6"],
            check: { type: "centralWedge" },
          },
          {
            id: "f4-legal",
            text: "f4 is a legal move in this position.",
            kind: "board",
            status: "mapped",
            reason: "The move was checked on this FEN.",
            evidence: ["san f4"],
            check: { type: "moveLegal", san: "f4" },
          },
          {
            id: "closed-search",
            text: `Stored ${closed.engineName} search at depth ${closed.depth} ended on ${closed.bestMoveSan}, ${closed.scoreWhiteLabel}.`,
            kind: "engine-report",
            status: "mapped",
            reason: "The stored PV was replayed. Depth does not promote the plan to mapped.",
            evidence: [`depth ${closed.depth}`, closed.bestMove],
            check: { type: "storedSearch", bestMove: closed.bestMove, minDepth: 8 },
          },
          {
            id: "closed-preference",
            text: `Engine preference in the stored search: ${closed.bestMoveSan}.`,
            kind: "engine-preference",
            status: "provisional",
            reason: "Search preference is not explanation confidence.",
            evidence: [`depth ${closed.depth}`],
          },
          {
            id: "f4-hypothesis",
            text: "One reading is that White can keep the wedge and still treat f4 as a future break. That is not proof.",
            kind: "strategic",
            status: "provisional",
            reason: "Plan language stays provisional.",
            evidence: ["Maintainer-written hypothesis."],
          },
          {
            id: "f4-plan-open",
            text: "Whether f4 is still the plan is not established by the rook on e1.",
            kind: "causal",
            status: "open",
            reason: "A rook square does not decide a future pawn break.",
            evidence: ["No causal check is possible from one piece placement."],
          },
        ],
        engine: engineBlock(closed),
        provenance: {
          source: "maintainer-seed",
          corpusVersion: version,
          note: "Seeded from a real Stockfish search plus board checks. Strategic sentences were not marked mapped.",
        },
      },
    ],
  };
  writeFileSync("corpus/positions.json", `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(
    "corpus/manifest.json",
    `${JSON.stringify({ name: "talkfish-shared-corpus", version, engine: open.engineName, seedDepth: 12, containsAccounts: false, containsDialogue: false }, null, 2)}\n`,
  );
  console.log(`open ${open.bestMoveSan} ${open.scoreWhiteLabel}`);
  console.log(`closed ${closed.bestMoveSan} ${closed.scoreWhiteLabel}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
