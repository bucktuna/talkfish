import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { EngineError } from "@/lib/engine-error";
import { positionKeyFromFen } from "@/lib/fen";
import type { EngineResult, EngineScore } from "@/lib/types";
import { formatWhiteScore, whiteMilli } from "@/lib/white-score";

export const LICHESS_ENGINE_NAME = "Lichess cloud eval";
export const CLOUD_COOLDOWN_MS = 60_000;

const MEMORY_MAX = 400;
const DISK_NAME = "lichess-cloud.json";
const USER_AGENT = "Talkfish/0.1 (educational chess coach)";

/**
 * Lichess cloud-eval numbers are already from White's side.
 * Checked on the public API: after 1.e4 (Black to move) cp is positive,
 * fool's mate (Black to move, Qh4#) is mate -1, and White's mate in 1 is mate 1.
 * A child position after a candidate move therefore keeps the same sign.
 */
export function cloudScoreToWhite(input: { cp?: number; mate?: number }): EngineScore | null {
  if (typeof input.mate === "number" && Number.isFinite(input.mate)) {
    return { kind: "mate", value: input.mate };
  }
  if (typeof input.cp === "number" && Number.isFinite(input.cp)) {
    return { kind: "cp", value: input.cp };
  }
  return null;
}

type CloudPv = { moves: string; cp?: number; mate?: number };
type CloudEval = { fen?: string; knodes?: number; depth: number; pvs: CloudPv[] };
type CacheEntry = { miss: true } | { miss: false; eval: CloudEval };

type Lookup =
  | { kind: "eval"; eval: CloudEval; fromCache: boolean; fetched: boolean }
  | { kind: "miss"; fromCache: boolean; fetched: boolean }
  | { kind: "cooling"; fromCache: false; fetched: boolean }
  | { kind: "timeout"; fromCache: false; fetched: boolean };

export type CloudFetcher = (
  url: string,
  init: { signal?: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; body: string }>;

type HttpResult = { kind: "http"; status: number; body: string } | { kind: "cooling" } | { kind: "timeout" };

let memory = new Map<string, CacheEntry>();
let chain: Promise<void> = Promise.resolve();
let cooldownUntil = 0;
let nowFn = () => Date.now();
let fetcher: CloudFetcher | null = null;
let timeoutMs = 8000;
let generation = 0;
let diskOverride: boolean | null = null;
let diskLoaded = false;

export function setCloudFetchForTests(fn: CloudFetcher | null): void {
  fetcher = fn;
}

export function setCloudClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function setCloudTimeoutForTests(ms: number | null): void {
  timeoutMs = ms ?? 8000;
}

export function setCloudDiskForTests(enabled: boolean): void {
  diskOverride = enabled;
  diskLoaded = false;
}

export function cloudCooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - nowFn());
}

export function resetCloudForTests(): void {
  generation += 1;
  memory = new Map();
  chain = Promise.resolve();
  cooldownUntil = 0;
  nowFn = () => Date.now();
  timeoutMs = 8000;
  diskOverride = false;
  diskLoaded = true;
}

export function clearCloudMemoryForTests(): void {
  memory = new Map();
  diskLoaded = false;
}

export function analyzeCloudFen(
  fen: string,
  _limits?: { depth?: number; movetimeMs?: number },
  signal?: AbortSignal,
  searchMoves?: string[],
): Promise<EngineResult> {
  void _limits;
  if (signal?.aborted) return Promise.reject(cancelled());
  if (searchMoves?.length) return analyzeCandidates(fen, searchMoves, signal);
  return analyzeRoot(fen, signal);
}

export async function lichessRequest(
  url: string,
  accept: string,
  signal?: AbortSignal,
): Promise<HttpResult> {
  if (signal?.aborted) throw cancelled();
  if (cloudCooldownRemainingMs() > 0) return { kind: "cooling" };
  return enqueue(signal, () => requestNow(url, accept, signal));
}

async function analyzeRoot(fen: string, signal?: AbortSignal): Promise<EngineResult> {
  const found = await lookup(fen, signal);
  if (found.kind === "cooling") return coverageResult(fen, "cooling-down", found.fetched);
  if (found.kind === "timeout") return coverageResult(fen, "timeout", true);
  if (found.kind === "miss") return coverageResult(fen, "not-in-cloud", found.fetched, found.fromCache);
  const pv = found.eval.pvs[0];
  const score = cloudScoreToWhite(pv);
  const moves = splitMoves(pv.moves);
  if (!score || !moves.length) return coverageResult(fen, "not-in-cloud", found.fetched, found.fromCache);
  return lineResult({
    fen,
    moves,
    score,
    depth: found.eval.depth,
    knodes: found.eval.knodes,
    fromCache: found.fromCache,
    searchedMove: null,
  });
}

async function analyzeCandidates(fen: string, searchMoves: string[], signal?: AbortSignal): Promise<EngineResult> {
  const turn = fen.split(" ")[1] === "b" ? "b" : "w";
  const root = await lookup(fen, signal);
  if (root.kind === "cooling") return coverageResult(fen, "cooling-down", root.fetched, false, searchMoves[0]);
  if (root.kind === "timeout") return coverageResult(fen, "timeout", true, false, searchMoves[0]);

  type Hit = { uci: string; moves: string[]; score: EngineScore; depth: number; knodes?: number; fetched: boolean };
  const hits: Hit[] = [];
  let fetched = root.fetched;
  const matched = new Set<string>();

  if (root.kind === "eval") {
    for (const pv of root.eval.pvs) {
      const moves = splitMoves(pv.moves);
      const uci = moves[0];
      if (!uci || !searchMoves.includes(uci) || matched.has(uci)) continue;
      const score = cloudScoreToWhite(pv);
      if (!score) continue;
      matched.add(uci);
      hits.push({ uci, moves, score, depth: root.eval.depth, knodes: root.eval.knodes, fetched: root.fetched });
    }
  }

  for (const uci of searchMoves) {
    if (matched.has(uci)) continue;
    const played = playUci(fen, uci);
    if (!played) throw new EngineError("A search move was not a legal UCI move.");
    if (played.chess.isGameOver()) {
      hits.push({
        uci,
        moves: [uci],
        score: rulesScore(played.chess),
        depth: 0,
        fetched: false,
      });
      continue;
    }
    const child = await lookup(played.chess.fen(), signal);
    fetched = fetched || child.fetched;
    if (child.kind === "cooling" || child.kind === "timeout") {
      if (!hits.length) {
        return coverageResult(fen, child.kind === "cooling" ? "cooling-down" : "timeout", true, false, uci);
      }
      break;
    }
    if (child.kind !== "eval") continue;
    const score = cloudScoreToWhite(child.eval.pvs[0]);
    const tail = splitMoves(child.eval.pvs[0].moves);
    if (!score) continue;
    hits.push({
      uci,
      moves: [uci, ...tail],
      score,
      depth: child.eval.depth,
      knodes: child.eval.knodes,
      fetched: child.fetched,
    });
  }

  if (!hits.length) return coverageResult(fen, "not-in-cloud", fetched, false, searchMoves[0]);
  let best = hits[0];
  for (const hit of hits.slice(1)) {
    const better = turn === "w" ? whiteMilli(hit.score) > whiteMilli(best.score) : whiteMilli(hit.score) < whiteMilli(best.score);
    if (better) best = hit;
  }
  return lineResult({
    fen,
    moves: best.moves,
    score: best.score,
    depth: best.depth,
    knodes: best.knodes,
    fromCache: !fetched,
    searchedMove: best.uci,
  });
}

async function lookup(fen: string, signal?: AbortSignal): Promise<Lookup> {
  ensureDisk();
  const key = positionKeyFromFen(fen);
  const cached = touch(key);
  if (cached) return fromEntry(cached, true);
  if (cloudCooldownRemainingMs() > 0) return { kind: "cooling", fromCache: false, fetched: false };
  const gen = generation;
  return enqueue(signal, async () => {
    const again = touch(key);
    if (again) return fromEntry(again, true);
    if (cloudCooldownRemainingMs() > 0) return { kind: "cooling", fromCache: false, fetched: false };
    const http = await requestNow(cloudUrl(fen), "application/json", signal);
    if (http.kind === "cooling") return { kind: "cooling", fromCache: false, fetched: true };
    if (http.kind === "timeout") return { kind: "timeout", fromCache: false, fetched: true };
    if (http.status === 404) {
      remember(key, { miss: true }, gen);
      return { kind: "miss", fromCache: false, fetched: true };
    }
    if (http.status !== 200) {
      throw new EngineError(`The cloud evaluation did not answer (HTTP ${http.status}).`);
    }
    const parsed = parseEval(http.body);
    if (!parsed) {
      remember(key, { miss: true }, gen);
      return { kind: "miss", fromCache: false, fetched: true };
    }
    remember(key, { miss: false, eval: parsed }, gen);
    return { kind: "eval", eval: parsed, fromCache: false, fetched: true };
  });
}

function fromEntry(entry: CacheEntry, fromCache: boolean): Lookup {
  if (entry.miss) return { kind: "miss", fromCache, fetched: false };
  return { kind: "eval", eval: entry.eval, fromCache, fetched: false };
}

async function requestNow(url: string, accept: string, signal?: AbortSignal): Promise<HttpResult> {
  if (signal?.aborted) throw cancelled();
  if (cloudCooldownRemainingMs() > 0) return { kind: "cooling" };
  const killer = new AbortController();
  const timer = setTimeout(() => killer.abort(), timeoutMs);
  const onUserAbort = () => killer.abort();
  signal?.addEventListener("abort", onUserAbort);
  try {
    const headers = { accept, "user-agent": USER_AGENT };
    const response = await (fetcher ?? defaultFetch)(url, { signal: killer.signal, headers });
    if (response.status === 429) {
      cooldownUntil = nowFn() + CLOUD_COOLDOWN_MS;
      return { kind: "cooling" };
    }
    return { kind: "http", status: response.status, body: response.body };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (killer.signal.aborted) return { kind: "timeout" };
    throw new EngineError(error instanceof Error ? error.message : "The cloud evaluation did not answer.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }
}

async function defaultFetch(
  url: string,
  init: { signal?: AbortSignal; headers: Record<string, string> },
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { signal: init.signal, headers: init.headers });
  return { status: response.status, body: await response.text() };
}

function enqueue<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const run = chain.then(() => {
    if (signal?.aborted) throw cancelled();
    return task();
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function cloudUrl(fen: string): string {
  return `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=5`;
}

function parseEval(body: string): CloudEval | null {
  let parsed: { fen?: string; knodes?: number; depth?: number; pvs?: Array<{ moves?: string; cp?: number; mate?: number }> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.depth !== "number" || !Array.isArray(parsed.pvs)) return null;
  const pvs: CloudPv[] = [];
  for (const pv of parsed.pvs) {
    if (!pv || typeof pv.moves !== "string" || !pv.moves.trim()) continue;
    if (!Number.isFinite(pv.cp) && !Number.isFinite(pv.mate)) continue;
    pvs.push({ moves: pv.moves.trim(), cp: pv.cp, mate: pv.mate });
  }
  if (!pvs.length) return null;
  return { fen: parsed.fen, knodes: parsed.knodes, depth: parsed.depth, pvs };
}

function lineResult(input: {
  fen: string;
  moves: string[];
  score: EngineScore;
  depth: number;
  knodes?: number;
  fromCache: boolean;
  searchedMove: string | null;
}): EngineResult {
  const played = replay(input.fen, input.moves);
  if (!played.sans.length) {
    return coverageResult(input.fen, "not-in-cloud", !input.fromCache, input.fromCache, input.searchedMove);
  }
  const deep = input.depth >= 8 && played.ok;
  return {
    available: true,
    terminal: null,
    winner: null,
    bestMove: played.legalUci[0] ?? null,
    bestMoveSan: played.sans[0] ?? null,
    ponder: played.legalUci[1] ?? null,
    depth: input.depth,
    seldepth: null,
    score: input.score,
    scoreWhiteLabel: formatWhiteScore(input.score),
    pv: played.legalUci,
    pvSan: played.sans,
    pvLegal: played.ok,
    nodes: typeof input.knodes === "number" ? input.knodes * 1000 : null,
    nps: null,
    timeMs: null,
    stable: deep,
    engineName: LICHESS_ENGINE_NAME,
    whitePov: true,
    searchedMove: input.searchedMove,
    fromCache: input.fromCache,
    coverage: "evaluated",
    preference: deep
      ? {
          status: "provisional",
          reason:
            "This is one cached Lichess cloud line from White's point of view. There is no per-depth trace, so stability is the stored depth rather than agreement across depths. Depth and a legal PV do not prove the move or explain it.",
        }
      : {
          status: "open",
          reason:
            input.depth < 8
              ? "The stored cloud depth is below 8, so the move preference stays open."
              : "The stored line did not replay as a fully legal PV, so the preference stays open.",
        },
  };
}

function coverageResult(
  fen: string,
  coverage: "not-in-cloud" | "cooling-down" | "timeout",
  fetched: boolean,
  fromCache = false,
  searchedMove: string | null = null,
): EngineResult {
  void fen;
  const copy =
    coverage === "not-in-cloud"
      ? {
          label: "No stored cloud evaluation",
          reason:
            "This position is not in the Lichess cloud cache, so there is no engine line. The reading stays provisional and unverified.",
        }
      : coverage === "cooling-down"
        ? {
            label: "The engine is cooling down",
            reason: "Lichess asked for a pause after too many requests. The engine is cooling down for about a minute.",
          }
        : {
            label: "The cloud evaluation timed out",
            reason: "The cloud evaluation timed out, so this reading is provisional and unverified.",
          };
  return {
    available: true,
    terminal: null,
    winner: null,
    bestMove: null,
    bestMoveSan: null,
    ponder: null,
    depth: 0,
    seldepth: null,
    score: null,
    scoreWhiteLabel: copy.label,
    pv: [],
    pvSan: [],
    pvLegal: true,
    nodes: null,
    nps: null,
    timeMs: null,
    stable: false,
    engineName: LICHESS_ENGINE_NAME,
    whitePov: true,
    searchedMove,
    fromCache: fromCache && !fetched,
    coverage,
    preference: { status: "open", reason: copy.reason },
  };
}

function rulesScore(chess: Chess): EngineScore {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "black" : "white";
    return { kind: "mate", value: winner === "white" ? 1 : -1 };
  }
  return { kind: "cp", value: 0 };
}

function playUci(fen: string, uci: string): { chess: Chess } | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const chess = new Chess(fen);
  try {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as "q" | "r" | "b" | "n" | undefined,
    });
    if (!move) return null;
    return { chess };
  } catch {
    return null;
  }
}

function replay(fen: string, pv: string[]): { ok: boolean; sans: string[]; legalUci: string[] } {
  const chess = new Chess(fen);
  const sans: string[] = [];
  const legalUci: string[] = [];
  for (const uci of pv.slice(0, 30)) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return { ok: false, sans, legalUci };
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] as "q" | "r" | "b" | "n" | undefined,
      });
      if (!move) return { ok: false, sans, legalUci };
      sans.push(move.san);
      legalUci.push(uci);
    } catch {
      return { ok: false, sans, legalUci };
    }
  }
  return { ok: pv.length <= 30, sans, legalUci };
}

function splitMoves(moves: string): string[] {
  return moves.split(/\s+/).filter(Boolean);
}

function touch(key: string): CacheEntry | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  memory.delete(key);
  memory.set(key, entry);
  return entry;
}

function remember(key: string, entry: CacheEntry, gen: number): void {
  if (gen !== generation) return;
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (!oldest) break;
    memory.delete(oldest);
  }
  scheduleDisk();
}

function diskOn(): boolean {
  if (diskOverride === false) return false;
  return Boolean(process.env.DATA_DIR);
}

function diskFile(): string | null {
  const dir = process.env.DATA_DIR;
  if (!dir || !diskOn()) return null;
  return path.join(dir, DISK_NAME);
}

function ensureDisk(): void {
  if (diskLoaded || !diskOn()) return;
  diskLoaded = true;
  const file = diskFile();
  if (!file || !existsSync(file)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return;
    for (const pair of parsed.entries) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
      const entry = pair[1] as CacheEntry;
      if (!entry || (entry.miss !== true && (!entry.eval || !Array.isArray(entry.eval.pvs)))) continue;
      memory.set(pair[0], entry);
    }
    while (memory.size > MEMORY_MAX) {
      const oldest = memory.keys().next().value;
      if (!oldest) break;
      memory.delete(oldest);
    }
  } catch {
    // A corrupt optional cache is ignored.
  }
}

function scheduleDisk(): void {
  const file = diskFile();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ entries: [...memory.entries()].slice(-MEMORY_MAX) }));
  } catch {
    // Disk cache is optional.
  }
}

function cancelled(): Error {
  const error = new Error("Analysis cancelled");
  error.name = "AbortError";
  return error;
}
