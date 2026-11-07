import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { positionKeyFromFen } from "../lib/fen";

const root = path.join(process.cwd(), "third_party", "lichess-chess-openings");
const commit = "3ba6b20d31b2e6125cb0e6a2e792f400717d9d39";

type NameHit = { eco: string; name: string; pgn: string; plies: number };

const index = new Map<string, { plies: number; hits: NameHit[] }>();
let rows = 0;
let skipped = 0;
const ecos = new Set<string>();

for (const file of readdirSync(root).filter((name) => name.endsWith(".tsv")).sort()) {
  const lines = readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "").split(/\n/);
  for (const line of lines) {
    if (!line.trim() || line.startsWith("eco\t")) continue;
    const [eco, name, pgn] = line.split("\t");
    if (!eco || !name || !pgn) {
      skipped += 1;
      continue;
    }
    rows += 1;
    ecos.add(eco);
    const chess = new Chess();
    try {
      chess.loadPgn(pgn.trim());
    } catch {
      skipped += 1;
      continue;
    }
    const sans = chess.history();
    if (!sans.length) {
      skipped += 1;
      continue;
    }
    const replay = new Chess();
    let legal = true;
    for (const san of sans) {
      try {
        if (!replay.move(san)) legal = false;
      } catch {
        legal = false;
      }
      if (!legal) break;
    }
    if (!legal) {
      skipped += 1;
      continue;
    }
    const key = positionKeyFromFen(replay.fen());
    const hit = { eco, name, pgn: pgn.trim(), plies: sans.length };
    const existing = index.get(key);
    if (!existing || hit.plies > existing.plies) {
      index.set(key, { plies: hit.plies, hits: [hit] });
    } else if (hit.plies === existing.plies && !existing.hits.some((item) => item.eco === eco && item.name === name && item.pgn === hit.pgn)) {
      existing.hits.push(hit);
    }
  }
}

const positions: Record<string, { plies: number; hits: NameHit[] }> = {};
for (const [key, value] of [...index.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  positions[key] = value;
}

const ambiguous = [...index.values()].filter((entry) => entry.hits.length > 1).length;
const doc = {
  source: {
    name: "lichess-org/chess-openings",
    commit,
    date: "2026-11-05T21:00:07Z",
    license: "CC0-1.0",
    url: "https://github.com/lichess-org/chess-openings",
  },
  rows,
  skipped,
  uniquePositions: index.size,
  ecoCount: ecos.size,
  ambiguousPositions: ambiguous,
  positions,
};

writeFileSync(path.join(process.cwd(), "openings", "index.json"), JSON.stringify(doc));
console.log(JSON.stringify({ rows, skipped, uniquePositions: index.size, ecoCount: ecos.size, ambiguous }, null, 2));
