import { lichessRequest } from "@/lib/lichess-cloud";
import { HttpError } from "@/lib/http/errors";
import type { LichessGameSummary } from "@/lib/types";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;

export async function fetchRecentLichessGames(username: string, signal?: AbortSignal): Promise<LichessGameSummary[]> {
  const name = username.trim();
  if (!USERNAME.test(name)) {
    throw new HttpError(400, "Enter a Lichess username (letters, numbers, underscore, or hyphen).");
  }
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(name)}?max=10&moves=true&opening=true&clocks=false&evals=false`;
  const http = await lichessRequest(url, "application/x-ndjson", signal);
  if (http.kind === "cooling") {
    throw new HttpError(429, "The engine is cooling down. Try again in about a minute.");
  }
  if (http.kind === "timeout") {
    throw new HttpError(504, "Lichess did not answer in time.");
  }
  if (http.status === 404) {
    throw new HttpError(404, "No Lichess user by that name, or their games are not public.");
  }
  if (http.status !== 200) {
    throw new HttpError(502, "Lichess did not return the games.");
  }
  const games: LichessGameSummary[] = [];
  for (const line of http.body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: {
      id?: string;
      variant?: string;
      speed?: string;
      winner?: string;
      moves?: string;
      opening?: { name?: string };
      players?: {
        white?: { user?: { name?: string } };
        black?: { user?: { name?: string } };
      };
    };
    try {
      row = JSON.parse(trimmed) as typeof row;
    } catch {
      continue;
    }
    if (row.variant && row.variant !== "standard") continue;
    if (!row.id || !row.moves?.trim()) continue;
    const white = cleanName(row.players?.white?.user?.name, "White");
    const black = cleanName(row.players?.black?.user?.name, "Black");
    const result = row.winner === "white" ? "1-0" : row.winner === "black" ? "0-1" : "1/2-1/2";
    const pgn = `[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n\n${row.moves.trim()} ${result}\n`;
    games.push({
      id: row.id,
      white,
      black,
      result,
      speed: row.speed || "game",
      opening: row.opening?.name ?? null,
      pgn,
    });
    if (games.length >= 10) break;
  }
  return games;
}

function cleanName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback).replace(/["\r\n\[\]]/g, "").slice(0, 40);
  return cleaned || fallback;
}
