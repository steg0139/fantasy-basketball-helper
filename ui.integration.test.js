/*
 * Integration check: mirrors exactly what index.html's recompute() feeds into
 * keeper.js, using league.sample.json. Confirms the wiring (draft map, inventory,
 * meta rounds/faStart, chosen players) produces correct, sensible results.
 * Run: node ui.integration.test.js
 */
const fs = require("fs");
const K = require("./keeper.js");

const league = JSON.parse(fs.readFileSync("./league.sample.json", "utf8"));
const rounds = league.meta.rounds;
const faStart = league.meta.faCostStartRound;

let pass = 0, fail = 0;
const fails = [];
function check(cond, msg) { cond ? pass++ : (fail++, fails.push("FAIL: " + msg)); }

function team(key) { return league.teams.find((t) => t.teamKey === key); }
function run(teamKey, selectedIds, inventory) {
  const roster = team(teamKey).roster;
  const chosen = roster.filter((p) => selectedIds.includes(p.playerId));
  return K.computeKeeperCost({
    players: chosen.map((p) => ({ playerId: p.playerId, name: p.name })),
    draft: league.draft,
    inventory: inventory || K.defaultInventory(rounds),
    rounds,
    faCostStartRound: faStart,
  });
}

// Team 1 "Dunk Dynasty": SGA(R1,can't keep), JWill(R3->2), Sengun(R3->2 collide),
// White(R5->4), Pritchard(R5->4 collide), Grimes(FA), Rollins(FA).

// A) Keep JWill + Sengun + White  (two R3s collide at base 2)
{
  const r = run("428.l.000000.t.1", ["101", "102", "103"]);
  check(r.valid, "A: valid");
  const by = Object.fromEntries(r.keepers.map((k) => [k.playerId, k.costRound]));
  // JWill base2, Sengun base2 -> one at R2, other bumps to R1; White base4 -> R4.
  const r3costs = [by["101"], by["102"]].sort();
  check(JSON.stringify(r3costs) === JSON.stringify([1, 2]), "A: two R3 keepers -> R1 & R2, got " + r3costs);
  check(by["103"] === 4, "A: White R5 -> R4, got " + by["103"]);
}

// B) Try to keep SGA (round 1) -> invalid, can't keep.
{
  const r = run("428.l.000000.t.1", ["100", "101", "103"]);
  check(!r.valid, "B: including a R1 player is invalid");
  check(r.errors.some((e) => /Round 1/.test(e)), "B: round-1 error present");
}

// C) Keep three FAs? Team1 only has two FAs; keep both FAs + White.
{
  const r = run("428.l.000000.t.1", ["900", "901", "103"]);
  check(r.valid, "C: valid");
  const by = Object.fromEntries(r.keepers.map((k) => [k.playerId, k.costRound]));
  // Two FAs -> R8 and R7; White -> R4.
  const faCosts = [by["900"], by["901"]].sort();
  check(JSON.stringify(faCosts) === JSON.stringify([7, 8]), "C: two FAs -> R7 & R8, got " + faCosts);
  check(by["103"] === 4, "C: White -> R4");
}

// D) Trade away R4 pick: JWill(R3->2), Sengun(R3->2), White(R5->4) with no R4 pick.
//    White base4 -> no R4 pick -> bump to R3. JWill/Sengun -> R2 & R1.
{
  const inv = K.defaultInventory(rounds);
  inv[4] = 0;
  const r = run("428.l.000000.t.1", ["101", "102", "103"], inv);
  check(r.valid, "D: valid after trading R4 away");
  const by = Object.fromEntries(r.keepers.map((k) => [k.playerId, k.costRound]));
  check(by["103"] === 3, "D: White bumps R4->R3 (no R4 pick), got " + by["103"]);
  const r3 = [by["101"], by["102"]].sort();
  check(JSON.stringify(r3) === JSON.stringify([1, 2]), "D: R3 keepers at R1,R2, got " + r3);
}

// E) Not enough capital: own only R1 pick, try to keep both R3 players (both need <=R2).
{
  const inv = {}; for (let i = 1; i <= rounds; i++) inv[i] = 0; inv[1] = 1;
  const r = run("428.l.000000.t.1", ["101", "102", "103"], inv);
  check(!r.valid, "E: three keepers but one pick -> invalid");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) { console.log("\n" + fails.join("\n")); process.exit(1); }
