import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "@/lib/http/router";
import { resetStoreForTests } from "@/lib/store";
import { clearRateLimitBucketsForTests, resetRateLimitsForTests, setLimitForTests } from "@/lib/rate-limit";
import { OPEN_GAME_FEN } from "@/lib/samples";

const origin = "http://127.0.0.1:43123";

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "talkfish-api-"));
  process.env.ALLOW_TEST_CLIENT_KEY = "1";
  process.env.APP_ORIGINS = origin;
  process.env.LLM_PROVIDER = "none";
  process.env.STOCKFISH_DEFAULT_DEPTH = "4";
  process.env.STOCKFISH_MOVETIME_MS = "300";
  process.env.CONTRIBUTION_SEARCH_DEPTH = "4";
  resetStoreForTests();
  resetRateLimitsForTests();
});

function call(pathname: string, init: { method?: string; body?: unknown; cookie?: string; client?: string } = {}) {
  const headers = new Headers({ origin, "content-type": "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.client) headers.set("x-talkfish-client", init.client);
  return handleApi(
    new Request(`${origin}${pathname}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
  );
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

describe("http", () => {
  it("lets a guest coach and blocks a guest submission", async () => {
    const health = await call("/api/health");
    expect((await health.json()).accountRequiredForCoaching).toBe(false);
    const coach = await call("/api/coach", {
      body: { fen: OPEN_GAME_FEN, question: "What is one developing idea?" },
      client: "guest-coach",
    });
    const body = await coach.json();
    expect(coach.status).toBe(200);
    expect(body.mode).toBe("engine-only");
    expect(body.reply.toLowerCase()).toContain("engine-only");
    const denied = await call("/api/contributions", {
      body: { fen: OPEN_GAME_FEN, explanation: "The knight on f3 develops toward the center." },
      client: "guest-submit",
    });
    expect(denied.status).toBe(401);
  });

  it("accepts a contributor submission as pending and quarantines an email", async () => {
    const signup = await call("/api/auth/signup", {
      body: { username: "ada_coach", password: "correct-horse-battery" },
      client: "signup-a",
    });
    expect(signup.status).toBe(201);
    const cookie = cookieFrom(signup);
    expect(cookie.startsWith("talkfish_session=")).toBe(true);
    const pending = await call("/api/contributions", {
      cookie,
      client: "contrib-a",
      body: {
        fen: OPEN_GAME_FEN,
        explanation: "A developing move can wait. This note is not a proof.",
        claims: [{ text: "The knight stands on f3.", assertion: "piece-on", square: "f3", piece: "n", color: "w" }],
      },
    });
    const saved = await pending.json();
    expect(pending.status).toBe(201);
    expect(saved.revision.status).toBe("pending");
    expect(saved.revision.claims.some((claim: { status: string }) => claim.status === "mapped")).toBe(true);
    const leaked = await call("/api/contributions", {
      cookie,
      client: "contrib-b",
      body: { fen: OPEN_GAME_FEN, explanation: "Mail me at player@example.com about this line." },
    });
    expect(leaked.status).toBe(202);
    expect((await leaked.json()).revision.status).toBe("quarantined");
    const forged = await call("/api/contributions", {
      cookie,
      client: "contrib-c",
      body: { fen: OPEN_GAME_FEN, explanation: "nope", status: "mapped", weight: 99 },
    });
    expect(forged.status).toBe(400);
  });

  it("does not let a guest report or a forged weight meet the penalty threshold", async () => {
    const signup = await call("/api/auth/signup", {
      body: { username: "bea_voter", password: "another-strong-pass" },
      client: "signup-b",
    });
    const cookie = cookieFrom(signup);
    const author = await call("/api/auth/login", {
      body: { username: "ada_coach", password: "correct-horse-battery" },
      client: "login-a",
    });
    const authorCookie = cookieFrom(author);
    const created = await call("/api/contributions", {
      cookie: authorCookie,
      client: "contrib-d",
      body: { fen: OPEN_GAME_FEN, explanation: "This is a provisional plan note only." },
    });
    const revisionId = (await created.json()).revision.id as string;
    const selfVote = await call("/api/votes", {
      cookie: authorCookie,
      client: "self-vote",
      body: { revisionId, direction: "down", weight: 50 },
    });
    expect(selfVote.status).toBe(403);
    const down = await call("/api/votes", {
      cookie,
      client: "vote-b",
      body: { revisionId, direction: "down", weight: 50 },
    });
    const voteBody = await down.json();
    expect(down.status).toBe(200);
    expect(voteBody.vote.weight).toBeLessThanOrEqual(0.05);
    expect(voteBody.eligibility.eligible).toBe(false);
    const again = await call("/api/votes", {
      cookie,
      client: "vote-b2",
      body: { revisionId, direction: "down", requestId: "same" },
    });
    expect((await again.json()).replayed).toBe(true);
    const guest = await call("/api/reports", { client: "guest-report", body: { revisionId, note: "looks wrong" } });
    expect(guest.status).toBe(200);
    expect((await guest.json()).countedTowardReputation).toBe(false);
    const review = await call("/api/review/queue", { cookie });
    expect(review.status).toBe(403);
  });

  it("rate limits guest reports", async () => {
    clearRateLimitBucketsForTests();
    setLimitForTests("report", { limit: 2, windowMs: 60_000 });
    const target = "seed-open-game";
    expect((await call("/api/reports", { client: "limit-ip", body: { revisionId: target } })).status).toBe(200);
    expect((await call("/api/reports", { client: "limit-ip", body: { revisionId: target } })).status).toBe(200);
    expect((await call("/api/reports", { client: "limit-ip", body: { revisionId: target } })).status).toBe(429);
  });
});
