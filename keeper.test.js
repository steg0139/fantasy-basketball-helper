/* Plain-node test harness for keeper.js (no deps). Run: node keeper.test.js */
const K = require("./keeper.js");

let pass = 0,
  fail = 0;
const failures = [];

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`);
  }
}
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`FAIL: ${msg}`);
  }
}

// Helper to build a players list + draft map.
function P(id, name) {
  return { playerId: id, name };
}

// ---- draft map used across tests ----
// p1 round1, p2 round2, p3 round3, p5a & p5b both round5, p10 round10
const draft = {
  p1: { round: 1 },
  p2: { round: 2 },
  p3: { round: 3 },
  p5a: { round: 5 },
  p5b: { round: 5 },
  p10: { round: 10 },
};

// 1. Basic drafted costs: round-1-earlier, default inventory.
{
  const r = K.computeKeeperCost({
    players: [P("p3", "C"), P("p5a", "E1"), P("p10", "J")],
    draft,
    rounds: 15,
  });
  ok(r.valid, "1: valid set");
  const byId = Object.fromEntries(r.keepers.map((k) => [k.playerId, k]));
  eq(byId.p3.costRound, 2, "1: round3 -> cost round2");
  eq(byId.p5a.costRound, 4, "1: round5 -> cost round4");
  eq(byId.p10.costRound, 9, "1: round10 -> cost round9");
}

// 2. Minimum keepers enforced.
{
  const r = K.computeKeeperCost({ players: [P("p3"), P("p5a")], draft, rounds: 15 });
  ok(!r.valid, "2: fewer than 3 is invalid");
  ok(r.errors.some((e) => /at least 3/.test(e)), "2: error mentions min 3");
}

// 3. Maximum keepers enforced.
{
  const players = [P("p2"), P("p3"), P("p5a"), P("p5b"), P("p10"), P("fa1"), P("fa2"), P("fa3")];
  const r = K.computeKeeperCost({ players, draft, rounds: 15 });
  ok(!r.valid, "3: more than 7 invalid");
  ok(r.errors.some((e) => /at most 7/.test(e)), "3: error mentions max 7");
}

// 4. Round-1 player cannot be kept.
{
  const r = K.computeKeeperCost({
    players: [P("p1", "Star"), P("p3"), P("p5a")],
    draft,
    rounds: 15,
  });
  ok(!r.valid, "4: round1 keeper invalid");
  ok(r.errors.some((e) => /Round 1/.test(e)), "4: error mentions round 1");
}

// 5. Collision with default inventory: two round-5 players, both base round4.
//    Default inv has one round-4 pick -> second bumps to round 3.
{
  const r = K.computeKeeperCost({
    players: [P("p5a", "A"), P("p5b", "B"), P("p10")],
    draft,
    rounds: 15,
  });
  ok(r.valid, "5: valid");
  const rounds = r.keepers
    .filter((k) => k.playerId === "p5a" || k.playerId === "p5b")
    .map((k) => k.costRound)
    .sort();
  eq(rounds, [3, 4], "5: two round-5 keepers consume rounds 3 and 4");
  ok(r.warnings.some((w) => /bumped/.test(w)), "5: a bump warning present");
}

// 6. Multiple picks in a round absorb the collision (no bump).
//    Own TWO round-4 picks -> both round-5 keepers sit at round 4.
{
  const inv = K.defaultInventory(15);
  inv[4] = 2;
  const r = K.computeKeeperCost({
    players: [P("p5a"), P("p5b"), P("p10")],
    draft,
    inventory: inv,
    rounds: 15,
  });
  ok(r.valid, "6: valid");
  const rounds = r.keepers
    .filter((k) => k.playerId === "p5a" || k.playerId === "p5b")
    .map((k) => k.costRound)
    .sort();
  eq(rounds, [4, 4], "6: both round-5 keepers sit at round 4 (two picks owned)");
  ok(!r.warnings.some((w) => /bumped/.test(w)), "6: no bump warning");
}

// 7. FA tiers: 3 FAs -> rounds 8,7,6.
{
  const r = K.computeKeeperCost({
    players: [P("fa1", "F1"), P("fa2", "F2"), P("fa3", "F3")],
    draft,
    rounds: 15,
  });
  ok(r.valid, "7: valid FA-only set");
  const rounds = r.keepers.map((k) => k.costRound).sort((a, b) => a - b);
  eq(rounds, [6, 7, 8], "7: three FAs cost rounds 6,7,8");
}

// 8. FA + drafted collision at round 8 bumps.
//    Keep an FA (base 8) and a round-9 draftee (base 8) -> second bumps to 7.
{
  const draft8 = Object.assign({}, draft, { p9: { round: 9 } });
  const r = K.computeKeeperCost({
    players: [P("fa1", "F1"), P("p9", "Nine"), P("p3")],
    draft: draft8,
    rounds: 15,
  });
  ok(r.valid, "8: valid");
  const byId = Object.fromEntries(r.keepers.map((k) => [k.playerId, k]));
  const used = [byId.fa1.costRound, byId.p9.costRound].sort();
  eq(used, [7, 8], "8: FA(8) and round9-draftee(8) land on 7 and 8");
}

// 9. Round-1 pick CAN be consumed by a bumped keeper.
//    Own only round-1 and round-2 picks. Keep p2 (base1) and p3 (base2).
//    p2 base1 -> round1 pick; p3 base2 -> round2 pick. Both placeable.
{
  const inv = { 1: 1, 2: 1 };
  const r = K.computeKeeperCost({
    players: [P("p2", "Two"), P("p3", "Three"), P("fa1")],
    draft,
    inventory: inv,
    rounds: 15,
  });
  // fa1 base 8 but no picks >=... only rounds 1,2 owned -> fa must bump to <=8 avail.
  // Available picks after p2,p3: none left (only two picks owned). So invalid.
  ok(!r.valid, "9a: three keepers but only two picks -> invalid");

  const r2 = K.computeKeeperCost({
    players: [P("p2", "Two"), P("p3", "Three"), P("p5a")],
    draft,
    inventory: { 1: 1, 2: 1, 4: 1 },
    rounds: 15,
  });
  ok(r2.valid, "9b: valid");
  const byId = Object.fromEntries(r2.keepers.map((k) => [k.playerId, k]));
  eq(byId.p2.costRound, 1, "9b: round-2 draftee consumes the round-1 pick");
  eq(byId.p3.costRound, 2, "9b: round-3 draftee consumes the round-2 pick");
  eq(byId.p5a.costRound, 4, "9b: round-5 draftee consumes the round-4 pick");
}

// 10. Unplaceable -> invalid. Keep two round-2 draftees (base1) but own one round-1 pick.
{
  const r = K.computeKeeperCost({
    players: [P("p2", "A"), { playerId: "p2b", name: "B" }, P("p3")],
    draft: Object.assign({}, draft, { p2b: { round: 2 } }),
    inventory: { 1: 1, 2: 1 },
    rounds: 15,
  });
  // Two base-1 keepers both need round<=1; only one round-1 pick exists -> invalid.
  ok(!r.valid, "10: two round-2 keepers can't both reach round 1 -> invalid");
  ok(r.errors.some((e) => /capital/.test(e)), "10: capital error present");
}

// 11. consumedRounds + totalPicksUsed reported on success.
{
  const r = K.computeKeeperCost({
    players: [P("p3"), P("p5a"), P("p10")],
    draft,
    rounds: 15,
  });
  eq(r.totalPicksUsed, 3, "11: three picks used");
  eq(r.consumedRounds, [2, 4, 9], "11: consumed rounds reported sorted");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n" + failures.join("\n\n"));
  process.exit(1);
}
