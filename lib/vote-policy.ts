/**
 * Vote weight policy `weight-policy-1`.
 *
 * Weights are computed only on the server from stored history. A client cannot
 * supply a weight. Snapshots are stored on each vote and are not rewritten
 * when later votes change someone's record, so reputation does not feed an
 * instant circular reweight.
 *
 * C = distinct engine-corroborated contributions (same position + same move
 *     does not count twice; a later disproof of that key removes it)
 * D = distinct contributions adjudicated unsupported or disproven
 * U = upvotes this account has received from other accounts
 * R = downvotes this account has received from other accounts
 *
 * pop = (U + 2) / (U + R + 4)                         Laplace, 0.5 with no votes
 * popMult = clamp(1 + 0.2 * (pop - 0.5), 0.9, 1)      neutral is 1; never above 1
 *
 * Established only when C >= 5 and C >= 2 * D. One confirmed explanation is
 * not enough, and received votes cannot make an unproven account established.
 *
 * Otherwise:
 *   weight = clamp(0.05 * popMult, 0.04, 0.05)
 *
 * If established:
 *   strength = clamp((C - D - 5) / 10, 0, 1)
 *   weight = clamp((0.75 + 0.25 * strength) * popMult, 0.60, 1)
 *
 * Reputation-impact eligibility uses downvotes only:
 *   at least 3 distinct other accounts (configurable upward, never below 3)
 *   AND counted weight >= 1.00
 * Newcomer weights on one revision are capped together at 0.45, so a farm of
 * new accounts cannot outweigh one established vote. Ten brand-new downvotes
 * sum to at most 0.50 before the cap and 0.45 after, which is less than the
 * neutral weight of one newly established account (0.75) and less than one
 * strong account (1.00).
 *
 * Eligibility only sends a dispute to adjudication. It does not change a
 * chess claim. Upvotes do not cancel the floor and do not prove a claim.
 * Three accounts are not three proven humans.
 */

export const VOTE_POLICY_VERSION = "weight-policy-1";

export const VOTE_POLICY = {
  minDistinctAccounts: 3,
  weightThreshold: 1,
  newcomerWeight: 0.05,
  newcomerWeightFloor: 0.04,
  newcomerPoolCap: 0.45,
  minConfirmedForEstablished: 5,
  establishedFloor: 0.6,
  establishedCeiling: 1,
} as const;

export type WeightStats = {
  confirmed: number;
  disproven: number;
  upReceived: number;
  downReceived: number;
};

export type WeightExplanation = {
  weight: number;
  established: boolean;
  popularity: number;
  popularityMultiplier: number;
  strength: number;
  reason: string;
  policyVersion: typeof VOTE_POLICY_VERSION;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function explainWeight(stats: WeightStats): WeightExplanation {
  const up = Math.max(0, stats.upReceived);
  const down = Math.max(0, stats.downReceived);
  const confirmed = Math.max(0, stats.confirmed);
  const disproven = Math.max(0, stats.disproven);
  const popularity = (up + 2) / (up + down + 4);
  const popularityMultiplier = clamp(1 + 0.2 * (popularity - 0.5), 0.9, 1);
  const established =
    confirmed >= VOTE_POLICY.minConfirmedForEstablished && confirmed >= 2 * disproven;

  if (!established) {
    const weight = clamp(
      round4(VOTE_POLICY.newcomerWeight * popularityMultiplier),
      VOTE_POLICY.newcomerWeightFloor,
      VOTE_POLICY.newcomerWeight,
    );
    return {
      weight,
      established: false,
      popularity,
      popularityMultiplier,
      strength: 0,
      policyVersion: VOTE_POLICY_VERSION,
      reason: `New or unproven account: ${confirmed} engine-confirmed contribution(s) and ${disproven} disproven. Received votes are ${up} up and ${down} down (smoothed popularity ${popularity.toFixed(2)}). That popularity cannot raise the weight above ${VOTE_POLICY.newcomerWeight.toFixed(2)}. Snapshot weight ${weight.toFixed(2)} under ${VOTE_POLICY_VERSION}.`,
    };
  }

  const strength = clamp((confirmed - disproven - 5) / 10, 0, 1);
  const base = 0.75 + 0.25 * strength;
  const weight = clamp(
    round4(base * popularityMultiplier),
    VOTE_POLICY.establishedFloor,
    VOTE_POLICY.establishedCeiling,
  );
  return {
    weight,
    established: true,
    popularity,
    popularityMultiplier,
    strength,
    policyVersion: VOTE_POLICY_VERSION,
    reason: `Established account: ${confirmed} distinct engine-confirmed contribution(s) and ${disproven} disproven, strength ${strength.toFixed(2)}. Received votes are ${up} up and ${down} down. The popularity multiplier is ${popularityMultiplier.toFixed(2)} and cannot increase the engine-derived weight. Snapshot weight ${weight.toFixed(2)} under ${VOTE_POLICY_VERSION}.`,
  };
}

export type CountedVote = {
  accountId: string;
  direction: "up" | "down";
  weight: number;
  established: boolean;
};

export type Eligibility = {
  distinctAccounts: number;
  countedWeight: number;
  newcomerWeightCounted: number;
  establishedWeightCounted: number;
  eligible: boolean;
  reviewFlag: boolean;
  minDistinctAccounts: number;
};

export function configuredMinDistinct(): number {
  const raw = process.env.REPUTATION_MIN_DISTINCT;
  if (!raw) return VOTE_POLICY.minDistinctAccounts;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return VOTE_POLICY.minDistinctAccounts;
  return Math.max(VOTE_POLICY.minDistinctAccounts, Math.min(20, parsed));
}

export function downvoteEligibility(votes: CountedVote[], minDistinct: number = VOTE_POLICY.minDistinctAccounts): Eligibility {
  const seen = new Set<string>();
  let newcomer = 0;
  let established = 0;
  for (const vote of votes) {
    if (vote.direction !== "down") continue;
    if (seen.has(vote.accountId)) continue;
    seen.add(vote.accountId);
    if (vote.established) established += vote.weight;
    else newcomer += vote.weight;
  }
  const newcomerWeightCounted = Math.min(newcomer, VOTE_POLICY.newcomerPoolCap);
  const countedWeight = round4(established + newcomerWeightCounted);
  const distinctAccounts = seen.size;
  return {
    distinctAccounts,
    countedWeight,
    newcomerWeightCounted: round4(newcomerWeightCounted),
    establishedWeightCounted: round4(established),
    eligible: distinctAccounts >= minDistinct && countedWeight >= VOTE_POLICY.weightThreshold,
    reviewFlag: distinctAccounts >= 1,
    minDistinctAccounts: minDistinct,
  };
}
