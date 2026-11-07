import { describe, expect, it } from "vitest";
import { downvoteEligibility, explainWeight, VOTE_POLICY } from "@/lib/vote-policy";

describe("vote weights", () => {
  it("gives a new account a tiny weight and ignores popularity as a path to trust", () => {
    expect(explainWeight({ confirmed: 0, disproven: 0, upReceived: 0, downReceived: 0 }).weight).toBe(0.05);
    expect(explainWeight({ confirmed: 1, disproven: 0, upReceived: 0, downReceived: 0 }).established).toBe(false);
    const popular = explainWeight({ confirmed: 0, disproven: 0, upReceived: 100, downReceived: 0 });
    expect(popular.established).toBe(false);
    expect(popular.weight).toBeLessThanOrEqual(VOTE_POLICY.newcomerWeight);
  });

  it("raises weight only after enough engine-confirmed history", () => {
    const established = explainWeight({ confirmed: 5, disproven: 0, upReceived: 0, downReceived: 0 });
    const strong = explainWeight({ confirmed: 15, disproven: 0, upReceived: 0, downReceived: 0 });
    expect(established.established).toBe(true);
    expect(established.weight).toBe(0.75);
    expect(strong.weight).toBe(1);
    expect(explainWeight({ confirmed: 6, disproven: 4, upReceived: 0, downReceived: 0 }).established).toBe(false);
  });

  it("keeps ten newcomers below one trusted vote and requires both floors", () => {
    const trusted = explainWeight({ confirmed: 15, disproven: 0, upReceived: 0, downReceived: 0 }).weight;
    const newbie = explainWeight({ confirmed: 0, disproven: 0, upReceived: 0, downReceived: 0 }).weight;
    expect(newbie * 10).toBeLessThan(trusted);
    const ten = Array.from({ length: 10 }, (_, index) => ({
      accountId: `new-${index}`,
      direction: "down" as const,
      weight: newbie,
      established: false,
    }));
    const farm = downvoteEligibility(ten);
    expect(farm.countedWeight).toBeLessThan(trusted);
    expect(farm.eligible).toBe(false);
    const threeLow = downvoteEligibility(ten.slice(0, 3));
    expect(threeLow.distinctAccounts).toBe(3);
    expect(threeLow.eligible).toBe(false);
    const supported = downvoteEligibility([
      { accountId: "trusted", direction: "down", weight: trusted, established: true },
      { accountId: "a", direction: "down", weight: newbie, established: false },
      { accountId: "b", direction: "down", weight: newbie, established: false },
    ]);
    expect(supported.eligible).toBe(true);
    const alone = downvoteEligibility([
      { accountId: "trusted", direction: "down", weight: trusted, established: true },
    ]);
    expect(alone.eligible).toBe(false);
  });
});
