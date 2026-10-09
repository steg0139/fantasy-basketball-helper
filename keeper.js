/*
 * Keeper cost engine for the Yahoo fantasy basketball keeper tracker.
 *
 * League rules this encodes:
 *  - Keep 3 to 7 players.
 *  - A drafted player costs the pick ONE ROUND EARLIER than drafted
 *      (drafted round R  ->  base cost round R-1).
 *    Ownership doesn't matter; what matters is the round the player was drafted.
 *  - A player drafted in round 1 CANNOT be kept (cost would be "round 0").
 *  - Free-agent adds (undrafted) cost from round `faCostStartRound` (8) downward:
 *      1 FA  -> round 8; 2 FAs -> rounds 8 and 7; 3 FAs -> rounds 8, 7, 6; ...
 *  - Picks can be traded, so a team can own 0, 1, or many picks in a given round.
 *  - Each keeper consumes one owned pick in its cost round. If a cost round is
 *    oversubscribed (more keepers want it than the team owns picks there), the
 *    excess "bumps up" to the next lower-numbered round where the team still has
 *    a free pick (bumping makes a keeper MORE expensive).
 *  - A round-1 pick CAN be consumed by a bumped keeper (or a round-2 keeper); you
 *    just can't KEEP a round-1 player.
 *  - If a keeper cannot be placed on any owned pick at or below its base round,
 *    the whole keeper set is invalid ("not enough draft capital").
 *
 * Lower round NUMBER = earlier pick = more expensive. "Bump up" means move to a
 * lower round number.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Keeper = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Build the default pick inventory: one pick in each round 1..rounds.
   * Returns an object { round: count }.
   */
  function defaultInventory(rounds) {
    const inv = {};
    for (let r = 1; r <= rounds; r++) inv[r] = 1;
    return inv;
  }

  /**
   * Determine a player's keeper type and base cost round.
   *
   * @param {object} player  { playerId, name }
   * @param {object} draft   map playerId -> { round }
   * @returns {object} { playerId, name, type: "drafted"|"fa",
   *                     draftRound|null, baseRound|null, keepable, reason }
   *   For FA players baseRound is null here; FA base rounds are assigned by
   *   computeKeeperCost because they depend on how many FAs are in the set.
   */
  function classifyPlayer(player, draft) {
    const d = draft[player.playerId];
    if (d && d.round != null) {
      const draftRound = d.round;
      if (draftRound <= 1) {
        return {
          playerId: player.playerId,
          name: player.name,
          type: "drafted",
          draftRound,
          baseRound: null,
          keepable: false,
          reason: "Round 1 picks can't be kept",
        };
      }
      return {
        playerId: player.playerId,
        name: player.name,
        type: "drafted",
        draftRound,
        baseRound: draftRound - 1,
        keepable: true,
        reason: null,
      };
    }
    return {
      playerId: player.playerId,
      name: player.name,
      type: "fa",
      draftRound: null,
      baseRound: null, // assigned later
      keepable: true,
      reason: null,
    };
  }

  /**
   * Place a set of desired base rounds against a pick inventory, bumping up
   * (to lower round numbers) when a round is oversubscribed.
   *
   * Greedy strategy that minimizes total spent cost: process desired rounds from
   * the most expensive (lowest number) to the cheapest (highest number). For each,
   * take the lowest-numbered actually-available pick that is <= its base round...
   *
   * Wait: bumping should only make things more expensive when forced. The correct
   * objective: each keeper must land on an owned pick at a round <= its base round
   * (can't get cheaper than base), and each pick used once. We want a feasible
   * assignment; if multiple exist, prefer the one spending the cheapest picks
   * (highest round numbers). We solve this exactly with a greedy that processes
   * desired base rounds from cheapest (highest number) to most expensive, each
   * time grabbing the HIGHEST-numbered free pick that is <= base. This is the
   * classic bipartite matching greedy and yields a feasible assignment whenever
   * one exists.
   *
   * @param {number[]} baseRounds   desired base cost round per keeper
   * @param {object}   inventory    { round: count } owned picks
   * @param {number}   rounds       total rounds (for bounds)
   * @returns {object} { ok, assignments: [{baseRound, costRound, bumped}], failedBaseRound }
   */
  function placeAgainstInventory(baseRounds, inventory, rounds) {
    // Expand inventory into a sorted list of individual pick rounds.
    const freeByRound = {};
    for (let r = 1; r <= rounds; r++) {
      freeByRound[r] = inventory[r] != null ? inventory[r] : 0;
    }

    // Process cheapest base first (highest round number). For each, consume the
    // highest-numbered free pick <= base round.
    const order = baseRounds
      .map((b, i) => ({ b, i }))
      .sort((x, y) => y.b - x.b); // descending base round (cheapest first)

    const assignments = new Array(baseRounds.length);

    for (const { b, i } of order) {
      let placed = -1;
      for (let r = Math.min(b, rounds); r >= 1; r--) {
        if (freeByRound[r] > 0) {
          placed = r;
          break;
        }
      }
      if (placed === -1) {
        return { ok: false, assignments: null, failedBaseRound: b };
      }
      freeByRound[placed] -= 1;
      assignments[i] = {
        baseRound: b,
        costRound: placed,
        bumped: placed < b,
      };
    }

    return { ok: true, assignments, failedBaseRound: null };
  }

  /**
   * Compute the keeper cost for a chosen set of players.
   *
   * @param {object} opts
   *   players: [{playerId, name}]  the chosen keepers (3..7)
   *   draft:   map playerId -> { round }
   *   inventory: { round: count }  team's owned picks for next season
   *   rounds:  total rounds (default 15)
   *   faCostStartRound: cheapest FA tier (default 8)
   * @returns {object} result (see below)
   */
  function computeKeeperCost(opts) {
    const rounds = opts.rounds || 15;
    const faStart = opts.faCostStartRound || 8;
    const draft = opts.draft || {};
    const inventory =
      opts.inventory && Object.keys(opts.inventory).length
        ? opts.inventory
        : defaultInventory(rounds);
    const players = opts.players || [];

    const errors = [];
    const warnings = [];

    if (players.length < 3) {
      errors.push("You must keep at least 3 players.");
    }
    if (players.length > 7) {
      errors.push("You can keep at most 7 players.");
    }

    // Classify each player.
    const classified = players.map((p) => classifyPlayer(p, draft));

    // Hard-stop: any non-keepable (round 1) player in the set.
    const nonKeepable = classified.filter((c) => !c.keepable);
    for (const c of nonKeepable) {
      errors.push(`${c.name || c.playerId}: ${c.reason}.`);
    }

    // Assign FA base rounds: faStart, faStart-1, ... for each FA in the set.
    const faPlayers = classified.filter((c) => c.keepable && c.type === "fa");
    faPlayers.forEach((c, idx) => {
      c.baseRound = faStart - idx;
    });
    const faUnderflow = faPlayers.filter((c) => c.baseRound < 1);
    for (const c of faUnderflow) {
      errors.push(
        `${c.name || c.playerId}: too many free agents kept; FA cost falls below round 1.`
      );
    }

    const keepable = classified.filter((c) => c.keepable);

    // If we already have fatal errors, return early with per-player base info.
    if (errors.length) {
      return {
        valid: false,
        errors,
        warnings,
        keepers: classified.map((c) => ({
          playerId: c.playerId,
          name: c.name,
          type: c.type,
          draftRound: c.draftRound,
          baseRound: c.baseRound,
          costRound: null,
          bumped: false,
          keepable: c.keepable,
          reason: c.reason,
        })),
        totalPicksUsed: 0,
        consumedRounds: [],
      };
    }

    const baseRounds = keepable.map((c) => c.baseRound);
    const placement = placeAgainstInventory(baseRounds, inventory, rounds);

    if (!placement.ok) {
      errors.push(
        "Not enough draft capital: can't fit all keepers onto owned picks " +
          `(stuck trying to place a keeper costing round ${placement.failedBaseRound} or earlier).`
      );
      return {
        valid: false,
        errors,
        warnings,
        keepers: keepable.map((c) => ({
          playerId: c.playerId,
          name: c.name,
          type: c.type,
          draftRound: c.draftRound,
          baseRound: c.baseRound,
          costRound: null,
          bumped: false,
          keepable: true,
          reason: null,
        })),
        totalPicksUsed: 0,
        consumedRounds: [],
      };
    }

    const keepers = keepable.map((c, i) => {
      const a = placement.assignments[i];
      if (a.bumped) {
        warnings.push(
          `${c.name || c.playerId}: bumped from round ${a.baseRound} to round ${a.costRound} (round ${a.baseRound} pick unavailable).`
        );
      }
      return {
        playerId: c.playerId,
        name: c.name,
        type: c.type,
        draftRound: c.draftRound,
        baseRound: c.baseRound,
        costRound: a.costRound,
        bumped: a.bumped,
        keepable: true,
        reason: null,
      };
    });

    const consumedRounds = keepers.map((k) => k.costRound).sort((a, b) => a - b);

    return {
      valid: true,
      errors,
      warnings,
      keepers,
      totalPicksUsed: keepers.length,
      consumedRounds,
    };
  }

  return {
    defaultInventory,
    classifyPlayer,
    placeAgainstInventory,
    computeKeeperCost,
  };
});
