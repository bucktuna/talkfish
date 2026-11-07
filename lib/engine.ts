import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Chess } from "chess.js";
import { EngineError } from "@/lib/engine-error";
import { analyzeCloudFen } from "@/lib/lichess-cloud";
import type { EngineResult, EngineScore } from "@/lib/types";
import { formatWhiteScore } from "@/lib/white-score";

export { EngineError };
export { formatWhiteScore };

export type SearchLimits = {
  depth: number;
  movetimeMs: number;
};

const live = new Set<ChildProcessWithoutNullStreams>();
let active = 0;
const waiters: Array<() => void> = [];
let cachedName: string | null = null;

const MAX_CONCURRENCY = 2;

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

export function activeEngineCount(): number {
  return live.size;
}

export function engineProvider(): "lichess" | "uci" {
  const value = (process.env.ENGINE_PROVIDER ?? "lichess").trim().toLowerCase();
  if (value === "uci" || value === "stockfish") return "uci";
  return "lichess";
}

export function resolveStockfishPath(): string {
  const fromEnv = process.env.STOCKFISH_PATH?.trim();
  if (fromEnv) {
    if (!/^[\w./+-]+$/.test(fromEnv)) {
      throw new EngineError("STOCKFISH_PATH contains unsupported characters.");
    }
    return fromEnv;
  }
  if (existsSync("/usr/local/bin/stockfish")) return "/usr/local/bin/stockfish";
  if (existsSync("/usr/games/stockfish")) return "/usr/games/stockfish";
  return "stockfish";
}

export function stockfishInstalled(): boolean {
  try {
    const bin = resolveStockfishPath();
    if (existsSync(bin)) return true;
    if (bin.includes("/") || bin.includes("\\")) return false;
    const found = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
    return found.status === 0 && Boolean(found.stdout?.trim());
  } catch {
    return false;
  }
}

export function clampLimits(input?: { depth?: number; movetimeMs?: number }): SearchLimits {
  const maxDepth = numberEnv("STOCKFISH_MAX_DEPTH", 16);
  const defaultDepth = numberEnv("STOCKFISH_DEFAULT_DEPTH", 12);
  const defaultMove = numberEnv("STOCKFISH_MOVETIME_MS", 1200);
  let depth = input?.depth ?? defaultDepth;
  let movetimeMs = input?.movetimeMs ?? defaultMove;
  if (!Number.isFinite(depth)) depth = defaultDepth;
  if (!Number.isFinite(movetimeMs)) movetimeMs = defaultMove;
  depth = Math.min(maxDepth, Math.max(1, Math.floor(depth)));
  movetimeMs = Math.min(8000, Math.max(50, Math.floor(movetimeMs)));
  return { depth, movetimeMs };
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function engineName(): Promise<string> {
  if (cachedName) return cachedName;
  const result = await analyzeFen(
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    { depth: 1, movetimeMs: 50 },
  );
  return result.engineName;
}

export async function analyzeFen(
  fen: string,
  limitsInput?: { depth?: number; movetimeMs?: number },
  signal?: AbortSignal,
  searchMoves?: string[],
): Promise<EngineResult> {
  if (fen.includes("\n") || fen.includes("\r")) {
    throw new EngineError("The FEN is not valid.");
  }
  const chess = new Chess(fen);
  const canonical = chess.fen();
  if (chess.isGameOver()) {
    const name = engineProvider() === "uci" ? cachedName ?? "Stockfish" : "Lichess cloud eval";
    return terminalResult(chess, name);
  }

  const limits = clampLimits(limitsInput);
  if (searchMoves) {
    for (const move of searchMoves) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
        throw new EngineError("A search move was not a legal UCI move.");
      }
    }
  }

  if (engineProvider() !== "uci") {
    return analyzeCloudFen(canonical, limits, signal, searchMoves);
  }
  return analyzeFenUci(canonical, limits, signal, searchMoves);
}

async function analyzeFenUci(
  canonical: string,
  limits: SearchLimits,
  signal?: AbortSignal,
  searchMoves?: string[],
): Promise<EngineResult> {
  await acquire();
  const proc = spawn(resolveStockfishPath(), [], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  live.add(proc);
  const onAbort = () => kill(proc);
  signal?.addEventListener("abort", onAbort);
  try {
    if (signal?.aborted) throw abortError();
    const reader = lineReader(proc);
    reader.send("uci");
    const hello = await reader.wait((line) => line === "uciok", 5000);
    const name = hello.find((line) => line.startsWith("id name "))?.slice("id name ".length) ?? "Stockfish";
    cachedName = name;
    reader.send("isready");
    await reader.wait((line) => line === "readyok", 5000);
    reader.send("ucinewgame");
    reader.send("isready");
    await reader.wait((line) => line === "readyok", 5000);
    reader.send("setoption name MultiPV value 1");
    reader.send(`position fen ${canonical}`);
    const search = searchMoves?.length ? ` searchmoves ${searchMoves.join(" ")}` : "";
    reader.send(`go depth ${limits.depth} movetime ${limits.movetimeMs}${search}`);
    const lines = await reader.wait((line) => line.startsWith("bestmove "), limits.movetimeMs + 10000);
    if (signal?.aborted) throw abortError();
    return parseSearch(canonical, lines, name, limits.depth, searchMoves?.[0] ?? null);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EngineError(
        "Stockfish is not installed. Install the distro package (apt install stockfish) or run the Docker Compose file. No engine result was invented.",
      );
    }
    if (signal?.aborted) throw abortError();
    throw error instanceof EngineError ? error : new EngineError(error instanceof Error ? error.message : "Engine failed");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    kill(proc);
    live.delete(proc);
    release();
  }
}

function abortError(): Error {
  const error = new Error("Analysis cancelled");
  error.name = "AbortError";
  return error;
}

function kill(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGKILL");
  }
}

function lineReader(proc: ChildProcessWithoutNullStreams) {
  let buffer = "";
  const waiters: Array<{
    pred: (line: string) => boolean;
    lines: string[];
    resolve: (lines: string[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    settled: boolean;
  }> = [];

  const settle = (waiter: (typeof waiters)[number], fn: () => void) => {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    fn();
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      for (const waiter of waiters) {
        if (waiter.settled) continue;
        waiter.lines.push(line);
        if (waiter.pred(line)) settle(waiter, () => waiter.resolve(waiter.lines));
      }
      index = buffer.indexOf("\n");
    }
  });
  proc.on("error", (error) => {
    for (const waiter of waiters) settle(waiter, () => waiter.reject(error));
  });
  proc.on("exit", (code) => {
    for (const waiter of waiters) {
      settle(waiter, () => waiter.reject(new EngineError(`Stockfish exited (${code ?? "signal"})`)));
    }
  });

  return {
    send(command: string) {
      proc.stdin.write(`${command}\n`);
    },
    wait(pred: (line: string) => boolean, timeoutMs: number) {
      return new Promise<string[]>((resolve, reject) => {
        const waiter = {
          pred,
          lines: [] as string[],
          resolve,
          reject,
          settled: false,
          timer: setTimeout(() => {
            settle(waiter, () => reject(new EngineError("Stockfish timed out")));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

type Info = {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  cp?: number;
  mate?: number;
  bound?: "lower" | "upper";
  nodes?: number;
  nps?: number;
  time?: number;
  pv?: string[];
};

function parseInfo(line: string): Info | null {
  if (!line.startsWith("info ")) return null;
  const parts = line.split(/\s+/);
  const info: Info = {};
  for (let i = 1; i < parts.length; i += 1) {
    const key = parts[i];
    if (key === "pv") {
      info.pv = parts.slice(i + 1);
      break;
    }
    if (key === "score") {
      const kind = parts[i + 1];
      const value = Number(parts[i + 2]);
      if (kind === "cp") info.cp = value;
      if (kind === "mate") info.mate = value;
      if (parts[i + 3] === "lowerbound") info.bound = "lower";
      if (parts[i + 3] === "upperbound") info.bound = "upper";
      continue;
    }
    const numeric = Number(parts[i + 1]);
    if (key === "depth") info.depth = numeric;
    else if (key === "seldepth") info.seldepth = numeric;
    else if (key === "multipv") info.multipv = numeric;
    else if (key === "nodes") info.nodes = numeric;
    else if (key === "nps") info.nps = numeric;
    else if (key === "time") info.time = numeric;
  }
  return info;
}

function parseSearch(
  fen: string,
  lines: string[],
  engineName: string,
  requestedDepth: number,
  searchedMove: string | null,
): EngineResult {
  const turn = fen.split(" ")[1] === "b" ? "b" : "w";
  const byDepth = new Map<number, string>();
  let best: Info | null = null;
  let bestMove: string | null = null;
  let ponder: string | null = null;
  for (const line of lines) {
    if (line.startsWith("bestmove ")) {
      const bits = line.split(/\s+/);
      bestMove = bits[1] && bits[1] !== "(none)" && bits[1] !== "0000" ? bits[1] : null;
      const ponderIndex = bits.indexOf("ponder");
      ponder = ponderIndex >= 0 ? bits[ponderIndex + 1] : null;
      continue;
    }
    const info = parseInfo(line);
    if (!info || (info.multipv && info.multipv !== 1) || !info.pv?.length || !info.depth) continue;
    byDepth.set(info.depth, info.pv[0]);
    if (!best || info.depth >= (best.depth ?? 0)) best = info;
  }
  const pv = best?.pv ?? (bestMove ? [bestMove] : []);
  if (!bestMove && pv[0]) bestMove = pv[0];
  const played = replayPv(fen, pv);
  const score = toWhiteScore(turn, best);
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const last = depths.slice(-3).map((depth) => byDepth.get(depth));
  const stable = last.length >= 3 && last.every((move) => move === last[0]);
  const depth = best?.depth ?? (bestMove ? requestedDepth : 0);
  const lowOrUnstable = depth < 8 || !stable || Boolean(score?.bound);
  return {
    available: true,
    terminal: null,
    winner: null,
    bestMove,
    bestMoveSan: played.sans[0] ?? null,
    ponder,
    depth,
    seldepth: best?.seldepth ?? null,
    score,
    scoreWhiteLabel: formatWhiteScore(score),
    pv: played.legalUci,
    pvSan: played.sans,
    pvLegal: played.ok,
    nodes: best?.nodes ?? null,
    nps: best?.nps ?? null,
    timeMs: best?.time ?? null,
    stable,
    engineName,
    whitePov: true,
    searchedMove,
    preference: lowOrUnstable
      ? {
          status: "open",
          reason: score?.bound
            ? "The score was only a bound, so the preference stays open."
            : depth < 8
              ? "The search depth is below 8, so the move preference stays open."
              : "The first move changed across the last depths, so the preference stays open.",
        }
      : {
          status: "provisional",
          reason:
            "This is one finite search preference from White's point of view. Depth and a legal PV do not prove the move or explain it.",
        },
  };
}

function toWhiteScore(turn: "w" | "b", info: Info | null): EngineScore | null {
  if (!info) return null;
  const sign = turn === "w" ? 1 : -1;
  if (typeof info.mate === "number" && Number.isFinite(info.mate)) {
    return { kind: "mate", value: sign * info.mate, bound: info.bound };
  }
  if (typeof info.cp === "number" && Number.isFinite(info.cp)) {
    return { kind: "cp", value: sign * info.cp, bound: info.bound };
  }
  return null;
}

function replayPv(fen: string, pv: string[]): { ok: boolean; sans: string[]; legalUci: string[] } {
  const chess = new Chess(fen);
  const sans: string[] = [];
  const legalUci: string[] = [];
  for (const uci of pv) {
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
  return { ok: true, sans, legalUci };
}

function terminalResult(chess: Chess, name: string): EngineResult {
  const turn = chess.turn();
  let terminal: EngineResult["terminal"] = "draw";
  let winner: EngineResult["winner"] = null;
  let score: EngineScore | null = { kind: "cp", value: 0 };
  if (chess.isCheckmate()) {
    terminal = "checkmate";
    winner = turn === "w" ? "black" : "white";
    score = { kind: "mate", value: winner === "white" ? 1 : -1 };
  } else if (chess.isStalemate()) {
    terminal = "stalemate";
    score = { kind: "cp", value: 0 };
  }
  return {
    available: true,
    terminal,
    winner,
    bestMove: null,
    bestMoveSan: null,
    ponder: null,
    depth: 0,
    seldepth: null,
    score,
    scoreWhiteLabel: chess.isCheckmate()
      ? `${winner === "white" ? "White" : "Black"} has already won by checkmate`
      : "The position is already a draw",
    pv: [],
    pvSan: [],
    pvLegal: true,
    nodes: null,
    nps: null,
    timeMs: null,
    stable: false,
    engineName: name,
    whitePov: true,
    preference: {
      status: "open",
      reason: "The game is already over, so there is no search preference.",
    },
  };
}

export async function shutdownEngines(): Promise<void> {
  for (const proc of live) kill(proc);
  live.clear();
}
