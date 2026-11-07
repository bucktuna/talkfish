import type { CorpusClaim, CorpusFile, CorpusPosition } from "@/lib/corpus";
import { validateCorpus } from "@/lib/corpus";
import type { ClaimStatus } from "@/lib/types";

const RANK: Record<ClaimStatus, number> = { open: 0, provisional: 1, mapped: 2 };

export type MergeConflict = {
  positionKey: string;
  claimId: string;
  kept: ClaimStatus;
  discarded: ClaimStatus;
};

export function mergeCorpus(base: CorpusFile, incoming: CorpusPosition[]): {
  corpus: CorpusFile;
  conflicts: MergeConflict[];
  errors: string[];
} {
  const errors: string[] = [];
  const conflicts: MergeConflict[] = [];
  const positions = new Map(base.positions.map((position) => [position.positionKey, structuredClone(position)]));
  const ordered = [...incoming].sort((a, b) => a.positionKey.localeCompare(b.positionKey) || a.id.localeCompare(b.id));
  for (const candidate of ordered) {
    const probe: CorpusFile = { version: base.version, positions: [candidate], patterns: [] };
    const candidateErrors = validateCorpus(probe);
    if (candidateErrors.length) {
      errors.push(...candidateErrors.map((error) => `${candidate.id}: ${error}`));
      continue;
    }
    const existing = positions.get(candidate.positionKey);
    if (!existing) {
      positions.set(candidate.positionKey, {
        ...candidate,
        claims: candidate.claims.map((claim) => forceConservative(claim)),
      });
      continue;
    }
    const mergedClaims = [...existing.claims];
    for (const claim of [...candidate.claims].sort((a, b) => a.id.localeCompare(b.id))) {
      const index = mergedClaims.findIndex((item) => item.id === claim.id);
      if (index < 0) {
        mergedClaims.push(forceConservative(claim));
        continue;
      }
      const current = mergedClaims[index];
      if (RANK[claim.status] === RANK[current.status] && claim.text === current.text) continue;
      const kept = RANK[claim.status] < RANK[current.status] ? claim.status : current.status;
      const discarded = kept === claim.status ? current.status : claim.status;
      if (kept !== current.status || claim.text !== current.text) {
        conflicts.push({ positionKey: candidate.positionKey, claimId: claim.id, kept, discarded });
      }
      mergedClaims[index] = {
        ...current,
        status: kept,
        evidence: [...new Set([...current.evidence, ...claim.evidence])],
        provenanceNote: current.reason,
        reason: `${current.reason} Merge kept the more conservative status (${kept}).`,
      } as CorpusClaim;
    }
    positions.set(candidate.positionKey, { ...existing, claims: mergedClaims });
  }
  const corpus: CorpusFile = {
    ...base,
    positions: [...positions.values()].sort((a, b) => a.positionKey.localeCompare(b.positionKey)),
  };
  return { corpus, conflicts, errors };
}

function forceConservative(claim: CorpusClaim): CorpusClaim {
  if ((claim.kind === "strategic" || claim.kind === "method") && claim.status === "mapped") {
    return { ...claim, status: "provisional", reason: `${claim.reason} Incoming mapped strategic text was lowered.` };
  }
  if (claim.kind === "causal" && claim.status !== "open") {
    return { ...claim, status: "open", reason: `${claim.reason} Incoming causal text stays open.` };
  }
  return claim;
}
