import { z } from "zod";
import { downvoteEligibility, configuredMinDistinct, type CountedVote } from "@/lib/vote-policy";
import { findPosition, exportCorpusText, loadPackagedCorpus } from "@/lib/corpus";
import { runCoachTurn, runOrientation } from "@/lib/coach";
import { createContribution, quarantineReason } from "@/lib/contributions";
import { EngineError } from "@/lib/engine";
import { HttpError } from "@/lib/http/errors";
import { clientKey, enforceLimit } from "@/lib/rate-limit";
import { redact } from "@/lib/redact";
import { sessionKey } from "@/lib/session-memory";
import { resolveStockfishPath } from "@/lib/engine";
import { getProvider } from "@/lib/llm";
import {
  accountStats,
  addEvent,
  addReport,
  castVote,
  createSession,
  createUser,
  deleteSession,
  findUserByUsername,
  getRevision,
  listEvents,
  listReports,
  listRevisions,
  penaltyState,
  publicUser,
  saveRevision,
  sha256,
  userFromToken,
  verifyPassword,
  votesFor,
  weightPreview,
} from "@/lib/store";
import { existsSync } from "node:fs";

const coachSchema = z.strictObject({
  fen: z.string().min(8).max(200),
  question: z.string().max(2000).optional(),
  depth: z.number().int().min(1).max(16).optional(),
  movetimeMs: z.number().int().min(50).max(8000).optional(),
  requestId: z.string().max(80).optional(),
  startFen: z.string().min(8).max(200).optional(),
  historySans: z.array(z.string().min(2).max(16)).max(240).optional(),
});

const authSchema = z.strictObject({
  username: z.string().min(3).max(32),
  password: z.string().min(10).max(128),
});

const contributionSchema = z.strictObject({
  fen: z.string().min(8).max(200),
  explanation: z.string().min(1).max(4000),
  claims: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(500),
        assertion: z.enum(["best-move", "legal-move", "piece-on"]).optional(),
        san: z.string().min(2).max(12).optional(),
        square: z.string().regex(/^[a-h][1-8]$/).optional(),
        piece: z.enum(["p", "n", "b", "r", "q", "k"]).optional(),
        color: z.enum(["w", "b"]).optional(),
      }),
    )
    .max(8)
    .optional(),
});

const voteSchema = z.strictObject({
  revisionId: z.string().min(4).max(80),
  direction: z.enum(["up", "down"]),
  requestId: z.string().max(80).optional(),
});

const reportSchema = z.strictObject({
  revisionId: z.string().min(4).max(80),
  note: z.string().max(500).optional(),
});

const reviewSchema = z.strictObject({
  revisionId: z.string().min(4).max(80),
  decision: z.enum(["unsupported", "disproven", "reverse-penalty", "engine-stands"]),
});

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export async function handleApi(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/health" && req.method === "GET") return await health();
    if (path === "/api/corpus" && req.method === "GET") return corpus(url);
    if (path === "/api/orient" && req.method === "POST") return await orient(req);
    if (path === "/api/coach" && req.method === "POST") return await coach(req);
    if (path === "/api/auth/signup" && req.method === "POST") return await signup(req);
    if (path === "/api/auth/login" && req.method === "POST") return await login(req);
    if (path === "/api/auth/logout" && req.method === "POST") return await logout(req);
    if (path === "/api/auth/me" && req.method === "GET") return await me(req);
    if (path === "/api/contributions" && req.method === "POST") return await contribute(req);
    if (path === "/api/votes" && req.method === "POST") return await vote(req);
    if (path === "/api/reports" && req.method === "POST") return await report(req);
    if (path === "/api/review/queue" && req.method === "GET") return await queue(req);
    if (path === "/api/review/adjudicate" && req.method === "POST") return await adjudicate(req);
    if (path === "/api/account/weight" && req.method === "GET") return await myWeight(req);
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError) return json({ error: "The request was rejected.", issues: error.issues.map((issue) => issue.message) }, 400);
    console.error(redact(error instanceof Error ? error.message : "request failed"));
    return json({ error: "Something went wrong." }, 500);
  }
}

async function health(): Promise<Response> {
  const provider = getProvider();
  const model = await provider.available();
  let engine: { available: boolean; name?: string; error?: string } = { available: false };
  try {
    const path = resolveStockfishPath();
    engine = { available: existsSync(path) || path === "stockfish", name: path === "stockfish" ? "stockfish" : path };
  } catch (error) {
    engine = { available: false, error: error instanceof Error ? error.message : "unavailable" };
  }
  let corpusVersion: string | null = null;
  try {
    corpusVersion = loadPackagedCorpus().version;
  } catch {
    corpusVersion = null;
  }
  return json({
    accountRequiredForCoaching: false,
    engine,
    model: { provider: provider.id, available: model.ok, reason: model.reason },
    corpusVersion,
    speech: "browser",
    votePolicy: "weight-policy-1",
  });
}

function corpus(url: URL): Response {
  const fen = url.searchParams.get("fen");
  const packaged = loadPackagedCorpus();
  if (!fen) {
    return json({
      version: packaged.version,
      positions: packaged.positions.map((position) => ({
        id: position.id,
        revisionId: position.revisionId,
        positionKey: position.positionKey,
        themes: position.themes,
      })),
    });
  }
  let record = null;
  try {
    record = findPosition(packaged, fen);
  } catch {
    return json({ error: "That FEN is not legal." }, 400);
  }
  return json({ version: packaged.version, baseline: record });
}

async function orient(req: Request): Promise<Response> {
  assertSameOrigin(req);
  enforceLimit("coach", clientKey(req));
  const body = coachSchema.parse(await readJson(req, 20_000));
  try {
    const result = await runOrientation(body.fen, { depth: body.depth, movetimeMs: body.movetimeMs }, req.signal, undefined, {
      startFen: body.startFen,
      historySans: body.historySans,
    });
    return json(result);
  } catch (error) {
    return engineFailure(error);
  }
}

async function coach(req: Request): Promise<Response> {
  assertSameOrigin(req);
  enforceLimit("coach", clientKey(req));
  const body = coachSchema.parse(await readJson(req, 20_000));
  if (!body.question?.trim()) throw new HttpError(400, "Type a question or a comment.");
  try {
    const result = await runCoachTurn({
      fen: body.fen,
      question: body.question,
      depth: body.depth,
      movetimeMs: body.movetimeMs,
      requestId: body.requestId,
      sessionId: sessionKey(req.headers.get("x-coach-session")),
      signal: req.signal,
      startFen: body.startFen,
      historySans: body.historySans,
    });
    return json(result);
  } catch (error) {
    return engineFailure(error);
  }
}

function engineFailure(error: unknown): Response {
  if (error instanceof HttpError) throw error;
  if (error instanceof Error && error.name === "AbortError") return json({ error: "Cancelled." }, 499);
  if (error instanceof EngineError) return json({ error: error.message }, 503);
  if (error instanceof Error && /illegal|Invalid FEN|FEN/i.test(error.message)) {
    return json({ error: "That FEN is not legal." }, 400);
  }
  throw error;
}

async function signup(req: Request): Promise<Response> {
  assertSameOrigin(req);
  enforceLimit("signup", clientKey(req));
  const body = authSchema.parse(await readJson(req));
  const user = await createUser({ username: body.username, password: body.password, role: "contributor" });
  const token = await createSession(user.id);
  return json({ user: publicUser(user) }, 201, { "set-cookie": sessionCookie(token, 14 * 24 * 60 * 60) });
}

async function login(req: Request): Promise<Response> {
  assertSameOrigin(req);
  enforceLimit("login", clientKey(req));
  const body = authSchema.parse(await readJson(req));
  const user = await findUserByUsername(body.username);
  const dummy = user ?? (await findUserByUsername(body.username));
  const ok = user ? await verifyPassword(body.password, user) : await verifyPassword(body.password, await dummyUser(body.password));
  if (!user || !ok || dummy === undefined) throw new HttpError(401, "Invalid username or password.");
  const token = await createSession(user.id);
  return json({ user: publicUser(user) }, 200, { "set-cookie": sessionCookie(token, 14 * 24 * 60 * 60) });
}

async function dummyUser(password: string) {
  const { hashPassword } = await import("@/lib/store");
  const hashed = await hashPassword(password, "00112233445566778899aabbccddeeff");
  return {
    id: "none",
    username: "none",
    passwordHash: hashed.hash,
    passwordSalt: hashed.salt,
    role: "contributor" as const,
    createdAt: "",
  };
}

async function logout(req: Request): Promise<Response> {
  assertSameOrigin(req);
  await deleteSession(tokenFrom(req));
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
}

async function me(req: Request): Promise<Response> {
  const user = await userFromToken(tokenFrom(req));
  if (!user) return json({ anonymous: true });
  return json({ anonymous: false, user: publicUser(user) });
}

async function myWeight(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const stats = await accountStats(user.id);
  return json({ stats, weight: weightPreview(stats) });
}

async function contribute(req: Request): Promise<Response> {
  assertSameOrigin(req);
  const user = await requireUser(req);
  enforceLimit("contribution", user.id);
  const body = contributionSchema.parse(await readJson(req));
  const revision = await createContribution({
    authorId: user.id,
    fen: body.fen,
    explanation: body.explanation,
    claims: body.claims,
  });
  return json({ revision: publicRevision(revision) }, revision.status === "quarantined" ? 202 : 201);
}

async function vote(req: Request): Promise<Response> {
  assertSameOrigin(req);
  const user = await requireUser(req);
  enforceLimit("vote", user.id);
  const raw = await readJson(req);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    delete (raw as Record<string, unknown>).weight;
    delete (raw as Record<string, unknown>).established;
  }
  const body = voteSchema.parse(raw);
  const target = await resolveTarget(body.revisionId);
  const cast = await castVote({
    revisionId: target.id,
    accountId: user.id,
    authorId: target.authorId,
    direction: body.direction,
    requestKey: sha256(`${user.id}|${target.id}|${body.direction}|${body.requestId ?? ""}`),
  });
  const eligibility = await eligibilityFor(target.id);
  return json({ vote: publicVote(cast.vote), replayed: cast.replayed, eligibility });
}

async function report(req: Request): Promise<Response> {
  assertSameOrigin(req);
  enforceLimit("report", clientKey(req));
  const body = reportSchema.parse(await readJson(req));
  await resolveTarget(body.revisionId);
  if (body.note && quarantineReason(body.note)) {
    throw new HttpError(400, "That report note looks like private content and was rejected.");
  }
  const stored = await addReport({
    revisionId: body.revisionId,
    ipHash: sha256(clientKey(req)),
    note: body.note?.slice(0, 500) ?? "",
  });
  return json({
    id: stored.id,
    countedTowardReputation: false,
    message: "Guest reports are separate from account votes and cannot meet the reputation threshold.",
  });
}

async function queue(req: Request): Promise<Response> {
  const user = await requireUser(req);
  if (user.role !== "moderator") throw new HttpError(403, "Review is limited to moderator accounts.");
  const revisions = await listRevisions();
  const reports = await listReports();
  const items = [];
  for (const revision of revisions) {
    const votes = await votesFor(revision.id);
    items.push({
      revision: publicRevision(revision),
      votes: votes.map(publicVote),
      eligibility: eligibilityFrom(votes),
      reports: reports.filter((report) => report.revisionId === revision.id).length,
    });
  }
  return json({ items });
}

async function adjudicate(req: Request): Promise<Response> {
  assertSameOrigin(req);
  const user = await requireUser(req);
  if (user.role !== "moderator") throw new HttpError(403, "Review is limited to moderator accounts.");
  const body = reviewSchema.parse(await readJson(req));
  const revision = await getRevision(body.revisionId);
  if (!revision) throw new HttpError(404, "Packaged corpus entries are not rewritten from review. There is no operational revision with that id.");
  const events = await listEvents();
  if (body.decision === "reverse-penalty") {
    const state = penaltyState(events, revision.id);
    if (!state.applied) throw new HttpError(409, "This revision has no reputation penalty to reverse.");
    if (state.reversed) return json({ reversed: true, replayed: true, revision: publicRevision(revision) });
    await addEvent({
      type: "penalty-reversed",
      accountId: revision.authorId,
      dedupeKey: `penalty:${revision.id}`,
      revisionId: revision.id,
      note: `Reversed by moderator ${user.id}. A second penalty for this revision is refused.`,
    });
    return json({ reversed: true, revision: publicRevision(revision) });
  }
  if (body.decision === "engine-stands") {
    return json({
      revision: publicRevision(revision),
      message: "Engine-backed claims were left as they are. Votes do not overrule them.",
    });
  }
  revision.claims = revision.claims.map((claim) => {
    if ((claim.kind === "engine-report" || claim.kind === "board") && claim.status === "mapped") {
      return { ...claim, reason: `${claim.reason} Review did not downgrade this checked fact.` };
    }
    return {
      ...claim,
      status: "open" as const,
      reason: `Adjudicated ${body.decision}. This did not rewrite engine evidence.`,
    };
  });
  revision.reviewFlag = true;
  await saveRevision(revision);
  const disprovenKey = `revision:${revision.id}`;
  if (!events.some((event) => event.type === "adjudicated-disproven" && event.dedupeKey === disprovenKey)) {
    await addEvent({
      type: "adjudicated-disproven",
      accountId: revision.authorId,
      dedupeKey: disprovenKey,
      revisionId: revision.id,
      note: `Adjudicated ${body.decision}.`,
    });
  }
  const eligibility = await eligibilityFor(revision.id);
  const state = penaltyState(await listEvents(), revision.id);
  let penalized = false;
  if (eligibility.eligible && !state.applied) {
    await addEvent({
      type: "penalty",
      accountId: revision.authorId,
      dedupeKey: `penalty:${revision.id}`,
      revisionId: revision.id,
      note: "One reputation impact for this revision after the weighted threshold and adjudication. Reversible once.",
    });
    penalized = true;
  }
  return json({ revision: publicRevision(revision), eligibility, penalized });
}

async function eligibilityFor(revisionId: string) {
  return eligibilityFrom(await votesFor(revisionId));
}

function eligibilityFrom(votes: Awaited<ReturnType<typeof votesFor>>) {
  const counted: CountedVote[] = votes.map((vote) => ({
    accountId: vote.accountId,
    direction: vote.direction,
    weight: vote.weight,
    established: vote.established,
  }));
  return downvoteEligibility(counted, configuredMinDistinct());
}

async function resolveTarget(revisionId: string): Promise<{ id: string; authorId: string | null }> {
  const revision = await getRevision(revisionId);
  if (revision) return { id: revision.id, authorId: revision.authorId };
  const corpus = loadPackagedCorpus();
  const packaged = corpus.positions.find((position) => position.revisionId === revisionId);
  if (packaged) return { id: packaged.revisionId, authorId: null };
  throw new HttpError(404, "That explanation was not found.");
}

async function requireUser(req: Request) {
  const user = await userFromToken(tokenFrom(req));
  if (!user) throw new HttpError(401, "Coaching does not need an account. Submitting or voting does.");
  return user;
}

function tokenFrom(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === "talkfish_session") return decodeURIComponent(rest.join("="));
  }
  return null;
}

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const allowed = (process.env.APP_ORIGINS || "http://127.0.0.1:43123,http://localhost:43123")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) {
    throw new HttpError(403, "Cross-origin request rejected.");
  }
}

async function readJson(req: Request, max = 100_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "Request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Expected JSON.");
  }
}

function sessionCookie(token: string, maxAge: number): string {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `talkfish_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function publicRevision(revision: Awaited<ReturnType<typeof getRevision>> & object) {
  return {
    id: revision.id,
    positionKey: revision.positionKey,
    fen: revision.fen,
    explanation: revision.explanation,
    claims: revision.claims,
    status: revision.status,
    reviewFlag: revision.reviewFlag,
    quarantineReason: revision.quarantineReason,
    createdAt: revision.createdAt,
  };
}

function publicVote(vote: Awaited<ReturnType<typeof votesFor>>[number]) {
  return {
    id: vote.id,
    revisionId: vote.revisionId,
    accountId: vote.accountId,
    direction: vote.direction,
    weight: vote.weight,
    established: vote.established,
    reason: vote.reason,
    policyVersion: vote.policyVersion,
    createdAt: vote.createdAt,
  };
}

export function packagedCorpusExport(): string {
  return exportCorpusText();
}
