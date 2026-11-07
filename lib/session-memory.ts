type SessionMemory = {
  covered: Set<string>;
  updatedAt: number;
};

const sessions = new Map<string, SessionMemory>();
const TTL_MS = 2 * 60 * 60 * 1000;

export function sessionKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
}

export function sessionHas(id: string | null, claimId: string): boolean {
  if (!id) return false;
  prune();
  return sessions.get(id)?.covered.has(claimId) ?? false;
}

export function sessionRemember(id: string | null, claimIds: string[]): void {
  if (!id || claimIds.length === 0) return;
  prune();
  const current = sessions.get(id) ?? { covered: new Set<string>(), updatedAt: Date.now() };
  for (const claimId of claimIds) current.covered.add(claimId);
  current.updatedAt = Date.now();
  sessions.set(id, current);
}

export function clearSessionsForTests(): void {
  sessions.clear();
}

function prune(): void {
  const now = Date.now();
  for (const [id, memory] of sessions) {
    if (now - memory.updatedAt > TTL_MS) sessions.delete(id);
  }
  if (sessions.size > 200) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of oldest.slice(0, sessions.size - 200)) sessions.delete(id);
  }
}
