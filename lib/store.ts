import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import type { Claim } from "@/lib/types";
import { explainWeight, type WeightStats } from "@/lib/vote-policy";
import { HttpError } from "@/lib/http/errors";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export type Role = "contributor" | "moderator";

export type User = {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  role: Role;
  createdAt: string;
};

export type Session = {
  tokenHash: string;
  userId: string;
  expiresAt: string;
};

export type Revision = {
  id: string;
  authorId: string;
  positionKey: string;
  fen: string;
  explanation: string;
  claims: Claim[];
  contentHash: string;
  status: "pending" | "quarantined" | "overlay";
  reviewFlag: boolean;
  createdAt: string;
  quarantineReason?: string;
};

export type Vote = {
  id: string;
  revisionId: string;
  accountId: string;
  direction: "up" | "down";
  weight: number;
  established: boolean;
  reason: string;
  policyVersion: string;
  requestKey: string;
  createdAt: string;
};

export type Report = {
  id: string;
  revisionId: string;
  ipHash: string;
  note: string;
  createdAt: string;
};

export type ReputationEvent = {
  id: string;
  type: "engine-confirmed" | "adjudicated-disproven" | "penalty" | "penalty-reversed";
  accountId: string;
  dedupeKey: string;
  revisionId?: string;
  createdAt: string;
  note: string;
};

type Database = {
  users: User[];
  sessions: Session[];
  revisions: Revision[];
  votes: Vote[];
  reports: Report[];
  events: ReputationEvent[];
};

let chain: Promise<unknown> = Promise.resolve();
let cached: { dir: string; db: Database } | null = null;

export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

export function resetStoreForTests(): void {
  cached = null;
}

function empty(): Database {
  return { users: [], sessions: [], revisions: [], votes: [], reports: [], events: [] };
}

async function load(): Promise<Database> {
  const dir = dataDir();
  if (cached?.dir === dir) return cached.db;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "operational.json");
  try {
    const db = JSON.parse(await readFile(file, "utf8")) as Database;
    cached = { dir, db: { ...empty(), ...db } };
  } catch {
    cached = { dir, db: empty() };
  }
  return cached.db;
}

async function save(db: Database): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "operational.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(db), { mode: 0o600 });
  await rename(tmp, file);
  cached = { dir, db };
}

function withDb<T>(fn: (db: Database) => Promise<T> | T): Promise<T> {
  const run = chain.then(() => load().then(fn).then(async (result) => result));
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function mutate<T>(fn: (db: Database) => Promise<T> | T): Promise<T> {
  return withDb(async (db) => {
    const result = await fn(db);
    await save(db);
    return result;
  });
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")): Promise<{ hash: string; salt: string }> {
  const derived = await deriveKey(password, Buffer.from(salt, "hex"));
  return { hash: derived.toString("hex"), salt };
}

export async function verifyPassword(password: string, user: User): Promise<boolean> {
  const derived = await deriveKey(password, Buffer.from(user.passwordSalt, "hex"));
  const stored = Buffer.from(user.passwordHash, "hex");
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

export function publicUser(user: User): { id: string; username: string; role: Role } {
  return { id: user.id, username: user.username, role: user.role };
}

export async function createUser(input: { username: string; password: string; role?: Role }): Promise<User> {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    throw new HttpError(400, "Usernames are 3–32 letters, numbers, underscores, or hyphens.");
  }
  if (input.password.length < 10 || input.password.length > 128) {
    throw new HttpError(400, "Passwords must be 10 to 128 characters.");
  }
  if (input.password.toLowerCase().includes(username.toLowerCase())) {
    throw new HttpError(400, "Choose a password that does not contain the username.");
  }
  const { hash, salt } = await hashPassword(input.password);
  return mutate((db) => {
    if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      throw new HttpError(409, "That username is not available.");
    }
    const user: User = {
      id: randomBytes(16).toString("hex"),
      username,
      passwordHash: hash,
      passwordSalt: salt,
      role: input.role ?? "contributor",
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    return user;
  });
}

export async function findUserByUsername(username: string): Promise<User | undefined> {
  const db = await load();
  return db.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  await mutate((db) => {
    db.sessions.push({
      tokenHash,
      userId,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });
  return token;
}

export async function userFromToken(token: string | null): Promise<User | null> {
  if (!token) return null;
  const db = await load();
  const session = db.sessions.find((item) => item.tokenHash === sha256(token));
  if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
  return db.users.find((user) => user.id === session.userId) ?? null;
}

export async function deleteSession(token: string | null): Promise<void> {
  if (!token) return;
  const hash = sha256(token);
  await mutate((db) => {
    db.sessions = db.sessions.filter((session) => session.tokenHash !== hash);
  });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function addRevision(revision: Revision): Promise<void> {
  await mutate((db) => {
    db.revisions.push(revision);
  });
}

export async function getRevision(id: string): Promise<Revision | undefined> {
  const db = await load();
  return db.revisions.find((revision) => revision.id === id);
}

export async function listRevisions(): Promise<Revision[]> {
  const db = await load();
  return db.revisions;
}

export async function saveRevision(revision: Revision): Promise<void> {
  await mutate((db) => {
    const index = db.revisions.findIndex((item) => item.id === revision.id);
    if (index < 0) throw new HttpError(404, "That explanation was not found.");
    db.revisions[index] = revision;
  });
}

export async function addEvent(event: Omit<ReputationEvent, "id" | "createdAt">): Promise<ReputationEvent> {
  const stored: ReputationEvent = { ...event, id: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
  await mutate((db) => {
    db.events.push(stored);
  });
  return stored;
}

export async function listEvents(): Promise<ReputationEvent[]> {
  const db = await load();
  return db.events;
}

export function statsFor(events: ReputationEvent[], votes: Vote[], revisions: Revision[], accountId: string): WeightStats {
  const confirmed = new Set(
    events.filter((event) => event.type === "engine-confirmed" && event.accountId === accountId).map((event) => event.dedupeKey),
  );
  const disproven = new Set(
    events.filter((event) => event.type === "adjudicated-disproven" && event.accountId === accountId).map((event) => event.dedupeKey),
  );
  for (const key of disproven) confirmed.delete(key);
  const authored = new Set(revisions.filter((revision) => revision.authorId === accountId).map((revision) => revision.id));
  const received = votes.filter((vote) => authored.has(vote.revisionId) && vote.accountId !== accountId);
  return {
    confirmed: confirmed.size,
    disproven: disproven.size,
    upReceived: received.filter((vote) => vote.direction === "up").length,
    downReceived: received.filter((vote) => vote.direction === "down").length,
  };
}

export async function accountStats(accountId: string): Promise<WeightStats> {
  const db = await load();
  return statsFor(db.events, db.votes, db.revisions, accountId);
}

export async function castVote(input: {
  revisionId: string;
  accountId: string;
  authorId: string | null;
  direction: "up" | "down";
  requestKey: string;
}): Promise<{ vote: Vote; replayed: boolean }> {
  const db = await load();
  if (input.authorId && input.authorId === input.accountId) {
    throw new HttpError(403, "You cannot vote on your own explanation.");
  }
  const existing = db.votes.find((vote) => vote.revisionId === input.revisionId && vote.accountId === input.accountId);
  if (existing) {
    if (existing.direction === input.direction || existing.requestKey === input.requestKey) {
      return { vote: existing, replayed: true };
    }
    throw new HttpError(409, "This account already voted on this revision.");
  }
  const stats = statsFor(db.events, db.votes, db.revisions, input.accountId);
  const weight = explainWeight(stats);
  const vote: Vote = {
    id: randomBytes(8).toString("hex"),
    revisionId: input.revisionId,
    accountId: input.accountId,
    direction: input.direction,
    weight: weight.weight,
    established: weight.established,
    reason: weight.reason,
    policyVersion: weight.policyVersion,
    requestKey: input.requestKey,
    createdAt: new Date().toISOString(),
  };
  await mutate((next) => {
    const again = next.votes.find((item) => item.revisionId === vote.revisionId && item.accountId === vote.accountId);
    if (again) return;
    next.votes.push(vote);
    if (vote.direction === "down") {
      const revision = next.revisions.find((item) => item.id === vote.revisionId);
      if (revision) revision.reviewFlag = true;
    }
  });
  return { vote, replayed: false };
}

export async function votesFor(revisionId: string): Promise<Vote[]> {
  const db = await load();
  return db.votes.filter((vote) => vote.revisionId === revisionId);
}

export async function addReport(report: Omit<Report, "id" | "createdAt">): Promise<Report> {
  const stored: Report = { ...report, id: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() };
  await mutate((db) => {
    db.reports.push(stored);
  });
  return stored;
}

export async function listReports(): Promise<Report[]> {
  const db = await load();
  return db.reports;
}

export function penaltyState(events: ReputationEvent[], revisionId: string): { applied: boolean; reversed: boolean } {
  const applied = events.some((event) => event.type === "penalty" && event.revisionId === revisionId);
  const reversed = events.some((event) => event.type === "penalty-reversed" && event.revisionId === revisionId);
  return { applied, reversed };
}

export async function snapshotDatabase(): Promise<Database> {
  const db = await load();
  return structuredClone(db);
}

export function weightPreview(stats: WeightStats) {
  return explainWeight(stats);
}
