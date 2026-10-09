/* Tests for importer.js. Run: node importer.test.js */
const I = require("./importer.js");

let pass = 0, fail = 0;
const fails = [];
function check(cond, msg) { cond ? pass++ : (fail++, fails.push("FAIL: " + msg)); }
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  x === y ? pass++ : (fail++, fails.push("FAIL: " + msg + "\n  expected " + y + "\n  got      " + x));
}

// --- cleanName ---
check(I.cleanName("Shai Gilgeous-Alexander (OKC - PG,SG)") === "Shai Gilgeous-Alexander", "clean: paren tag removed");
check(I.cleanName("Nikola Jokić Player Note") === "Nikola Jokić", "clean: player note removed");
check(I.cleanName("  LeBron  James  ") === "LeBron James", "clean: whitespace collapsed");

// --- looksLikeName ---
check(I.looksLikeName("PG,SG") === false, "looksLikeName: position code rejected");
check(I.looksLikeName("DEN") === false, "looksLikeName: team code rejected");
check(I.looksLikeName("Cade Cunningham") === true, "looksLikeName: real name accepted");

// --- parseDraft: "Round N" headers + bare pick lines ---
{
  const text = [
    "Round 1",
    "1 Victor Wembanyama (SAS - C)",
    "2 Nikola Jokic (DEN - C)",
    "Round 2",
    "13 Cade Cunningham (DET - PG)",
  ].join("\n");
  const { results } = I.parseDraft(text);
  eq(results.length, 3, "draft hdr: 3 rows");
  eq({ r: results[0].round, n: results[0].name }, { r: 1, n: "Victor Wembanyama" }, "draft hdr: row1");
  eq(results[2].round, 2, "draft hdr: round 2 carried from header");
}

// --- parseDraft: inline "R1 P3" style ---
{
  const text = [
    "R1 P3 Luka Doncic (LAL - PG)",
    "R2 P15 Jalen Johnson (ATL - PF)",
  ].join("\n");
  const { results } = I.parseDraft(text);
  eq(results.length, 2, "draft inline: 2 rows");
  eq({ r: results[0].round, p: results[0].pick, n: results[0].name },
     { r: 1, p: 3, n: "Luka Doncic" }, "draft inline: row1 round/pick/name");
  eq(results[1].round, 2, "draft inline: row2 round");
}

// --- parseDraft: "1.03" dotted style ---
{
  const text = "1.03 Shai Gilgeous-Alexander\n5.55 Derrick White";
  const { results } = I.parseDraft(text);
  eq(results[0].round, 1, "draft dotted: round");
  eq(results[0].pick, 3, "draft dotted: pick");
  eq(results[1].round, 5, "draft dotted: row2 round");
  check(results[0].name === "Shai Gilgeous-Alexander", "draft dotted: name");
}

// --- parseDraft: pipe columns "round | pick | player | team | manager" ---
{
  const text = [
    "1 | 1 | Victor Wembanyama | San Antonio Spurs | Adam King",
    "1 | 2 | Nikola Jokic | Denver Nuggets | Matty G",
  ].join("\n");
  const { results } = I.parseDraft(text);
  eq(results.length, 2, "draft pipe: 2 rows");
  eq({ r: results[0].round, p: results[0].pick, n: results[0].name },
     { r: 1, p: 1, n: "Victor Wembanyama" }, "draft pipe: parsed row1");
}

// --- parseRosters: blank-line separated blocks, first line = team name ---
{
  const text = [
    "Dunk Dynasty",
    "Shai Gilgeous-Alexander",
    "Jalen Williams",
    "Quentin Grimes",
    "",
    "Board Men",
    "Nikola Jokic",
    "Victor Wembanyama",
  ].join("\n");
  const { teams } = I.parseRosters(text);
  eq(teams.length, 2, "roster: 2 teams");
  eq(teams[0].name, "Dunk Dynasty", "roster: team1 name");
  eq(teams[0].players.length, 3, "roster: team1 player count");
  eq(teams[1].players[1], "Victor Wembanyama", "roster: team2 player2");
}

// --- parseRosters: "Team:" marker ---
{
  const text = "Team: Alpha\nLeBron James\n\nTeam: Beta\nStephen Curry";
  const { teams } = I.parseRosters(text);
  eq(teams[0].name, "Alpha", "roster marker: name stripped");
  eq(teams[1].name, "Beta", "roster marker: name2");
}

// --- buildLeagueJson: cross-reference FA detection + cost readiness ---
{
  const draft = I.parseDraft([
    "Round 1",
    "1 Nikola Jokic",
    "Round 3",
    "28 Jalen Williams",
    "Round 5",
    "55 Derrick White",
  ].join("\n")).results;

  const rosters = I.parseRosters([
    "Board Men",
    "Nikola Jokic",
    "Jalen Williams",
    "Quentin Grimes",       // not in draft -> FA
  ].join("\n")).teams;

  const { league, warnings } = I.buildLeagueJson({
    leagueName: "Test", season: 2025, rounds: 15, faCostStartRound: 8,
    draftRows: draft, rosterTeams: rosters,
  });

  // Jokic drafted r1 present in draft map.
  const jokicId = I.normKey("Nikola Jokic");
  check(league.draft["n:" + jokicId] && league.draft["n:" + jokicId].round === 1, "build: Jokic in draft r1");

  // Grimes NOT in draft -> absent from draft map (FA), and roster entry exists.
  const grimesId = "n:" + I.normKey("Quentin Grimes");
  check(!league.draft[grimesId], "build: Grimes absent from draft (FA)");
  const team = league.teams[0];
  check(team.roster.some((p) => p.playerId === grimesId), "build: Grimes on roster");
  check(warnings.some((w) => /free-agent/.test(w)), "build: FA warning emitted");

  // Name-based ids let the keeper engine resolve costs. Spot check with engine.
  const K = require("./keeper.js");
  const chosen = team.roster; // Jokic(r1,can't), JWill(r3->2), Grimes(FA)
  const res = K.computeKeeperCost({
    players: chosen.map((p) => ({ playerId: p.playerId, name: p.name })),
    draft: league.draft, rounds: 15, faCostStartRound: 8,
  });
  // Jokic is round 1 -> whole set invalid.
  check(!res.valid, "build+engine: set with Jokic(r1) invalid");

  // Drop Jokic: JWill(r3->2) + Grimes(FA r8) + add White via draft (not rostered here)
  const res2 = K.computeKeeperCost({
    players: [
      { playerId: "n:" + I.normKey("Jalen Williams"), name: "Jalen Williams" },
      { playerId: grimesId, name: "Quentin Grimes" },
      { playerId: "n:" + I.normKey("Derrick White"), name: "Derrick White" },
    ],
    draft: league.draft, rounds: 15, faCostStartRound: 8,
  });
  check(res2.valid, "build+engine: valid 3-keeper set");
  const by = Object.fromEntries(res2.keepers.map((k) => [k.name, k.costRound]));
  eq(by["Jalen Williams"], 2, "build+engine: JWill r3->2");
  eq(by["Derrick White"], 4, "build+engine: White r5->4");
  eq(by["Quentin Grimes"], 8, "build+engine: Grimes FA->8");
}

// --- diacritics matching: draft "Jokić" matches roster "Jokic" ---
{
  check(I.normKey("Nikola Jokić") === I.normKey("Nikola Jokic"), "normKey: diacritics folded");
}

// --- REAL Yahoo multi-line draft paste (from user's actual league) ---
const REAL = [
  "1.\tNikola Jokić", "(DEN - C)", "Why so serious?",
  "2.\tVictor Wembanyama", "(SAS - C)", "Wemby FMVP *",
  "3.\tShai Gilgeous-Alexander", "(OKC - PG)", "America Stole Basketball",
  "4.\tLuka Dončić", "(LAL - PG,SG)", "Wish Upon a Sarr",
  "5.\tGiannis Antetokounmpo", "(MIA - PF,C)", "Wish Upon a Sarr",
  "6.\tCade Cunningham", "(DET - PG,SG)", "Wemby FMVP *",
  "7.\tAnthony Edwards", "(MIN - PG,SG)", "Why so serious?",
  "8.\tKarl-Anthony Towns", "(NYK - PF,C)", "Wish Upon a Sarr",
  "\u00a0",
  "Round 2",
  "1.\tJaylen Brown ", "(PHI - SG,SF,PF)", "Kawhi Leonard Planting Trees",
  "2.\tTrae Young", "(WAS - PG)", "Why so serious?",
  "3.\tAnthony Davis", "(WAS - PF,C)", "Wemby FMVP *",
  "4.\tDevin Booker", "(PHX - PG,SG)", "Wish Upon a Sarr",
  "5.\tJames Harden", "(CLE - PG,SG)", "Wemby FMVP *",
  "6.\tDomantas Sabonis", "(SAC - PF,C)", "America Stole Basketball",
  "7.\tKevin Durant", "(HOU - SG,SF,PF)", "Wemby FMVP *",
  "8.\tStephen Curry", "(GSW - PG)", "Why so serious?",
  "\u00a0",
  "Round 3",
  "1.\tEvan Mobley", "(CLE - PF,C)", "Why so serious?",
  "2.\tTyrese Maxey", "(PHI - PG)", "Wemby FMVP *",
  "3.\tScottie Barnes", "(TOR - SF,PF,C)", "America Stole Basketball",
  "4.\tPascal Siakam", "(IND - PF,C)", "Wish Upon a Sarr",
  "5.\tDonovan Mitchell", "(CLE - PG,SG)", "Wish Upon a Sarr",
  "6.\tJalen Johnson", "(ATL - SF,PF)", "Wemby FMVP *",
  "7.\tAlperen Şengün", "(HOU - PF,C)", "Why so serious?",
  "8.\tJalen Williams", "(OKC - SF,PF)", "Wish Upon a Sarr",
].join("\n");

{
  const { results, warnings } = I.parseDraft(REAL);
  eq(results.length, 24, "REAL: 24 picks parsed (3 rounds x 8)");
  check(warnings.length === 0, "REAL: no parse warnings, got " + JSON.stringify(warnings));

  // Round 1 is implicit (no header) -> defaults to 1.
  eq({ r: results[0].round, p: results[0].pick, n: results[0].name, m: results[0].manager },
     { r: 1, p: 1, n: "Nikola Jokić", m: "Why so serious?" }, "REAL: pick 1.1");
  // Round headers advance the round.
  eq({ r: results[8].round, n: results[8].name }, { r: 2, n: "Jaylen Brown" }, "REAL: round 2 starts at index 8, name trimmed");
  eq({ r: results[16].round, n: results[16].name }, { r: 3, n: "Evan Mobley" }, "REAL: round 3");
  // Diacritics preserved in display name, team/pos stripped.
  eq(results[23].name, "Jalen Williams", "REAL: last pick name");
  eq(results[22].name, "Alperen Şengün", "REAL: diacritic name preserved");
  // Managers captured.
  check(results.filter((r) => r.manager === "Wish Upon a Sarr").length === 7, "REAL: manager counts (Wish Upon a Sarr x7)");
}

// --- Build from REAL draft with NO separate roster paste: rosters from managers ---
{
  const { results } = I.parseDraft(REAL);
  const { league, warnings } = I.buildLeagueJson({
    leagueName: "Dynasty", season: 2025, rounds: 15, faCostStartRound: 8,
    draftRows: results, rosterTeams: [],
  });
  // 5 distinct managers in this slice: Why so serious?, Wemby FMVP *,
  // America Stole Basketball, Wish Upon a Sarr, Kawhi Leonard Planting Trees.
  eq(league.teams.length, 5, "REAL build: 5 teams from managers");
  check(league.meta.rosterSource === "draft-managers", "REAL build: rosterSource flagged");
  check(warnings.some((w) => /reconstructed/.test(w)), "REAL build: reconstruction warning present");

  const wish = league.teams.find((t) => t.name === "Wish Upon a Sarr");
  check(wish && wish.roster.length === 7, "REAL build: Wish Upon a Sarr has 7 drafted players");

  // Engine spot check: keep SGA(r1 -> can't), so test a legal set for "Why so serious?"
  // Why so serious? drafted: Jokic(r1), Edwards(r7), Curry? no. Let's check Edwards cost.
  const K = require("./keeper.js");
  const why = league.teams.find((t) => t.name === "Why so serious?");
  // why roster: Jokic(1), Anthony Edwards(1*? no) ... compute from draft.
  // "Why so serious?" drafted (in this slice): Jokic(R1 p1), Edwards(R1 p7),
  // Trae Young(R2 p2), Stephen Curry(R2 p8), Evan Mobley(R3 p1).
  // Note Edwards is a ROUND-1 pick (pick 7 OF round 1) -> can't be kept.
  const edwards = why.roster.find((p) => p.name === "Anthony Edwards");
  const young = why.roster.find((p) => p.name === "Trae Young");
  const mobley = why.roster.find((p) => p.name === "Evan Mobley");
  const curry = why.roster.find((p) => p.name === "Stephen Curry");

  // Confirm the parser assigned the right draft rounds (this is the real validation).
  eq(league.draft[edwards.playerId].round, 1, "REAL: Edwards is a round-1 pick");
  eq(league.draft[young.playerId].round, 2, "REAL: Trae Young round 2");
  eq(league.draft[curry.playerId].round, 2, "REAL: Curry round 2");
  eq(league.draft[mobley.playerId].round, 3, "REAL: Mobley round 3");

  // A round-1 player can't be kept.
  const resEd = K.computeKeeperCost({
    players: [edwards, young, mobley], draft: league.draft, rounds: 15, faCostStartRound: 8,
  });
  check(!resEd.valid, "REAL: keeping round-1 Edwards is invalid");

  // Young(R2->1) + Mobley(R3->2) + one FA would be a clean valid set; test the two
  // drafted costs plus a borrowed FA to make a legal 3-keeper set.
  const faGuy = { playerId: "n:fa guy", name: "FA Guy" };
  const resOk = K.computeKeeperCost({
    players: [young, mobley, faGuy], draft: league.draft, rounds: 15, faCostStartRound: 8,
  });
  check(resOk.valid, "REAL: Young + Mobley + FA is a valid set");
  const by = Object.fromEntries(resOk.keepers.map((k) => [k.name, k.costRound]));
  eq(by["Trae Young"], 1, "REAL: Trae Young R2 -> cost R1");
  eq(by["Evan Mobley"], 2, "REAL: Mobley R3 -> cost R2");
  eq(by["FA Guy"], 8, "REAL: FA -> R8");

  // Young(R2->1) and Curry(R2->1) both need round 1 -> only one round-1 pick on
  // default inventory, so the pair can't both be kept.
  const resClash = K.computeKeeperCost({
    players: [young, curry, mobley], draft: league.draft, rounds: 15, faCostStartRound: 8,
  });
  check(!resClash.valid, "REAL: two round-2 keepers both need R1 -> invalid on default inventory");
}

// --- REAL Yahoo roster paste (rich stat view, one team) ---
const REAL_ROSTER = [
  "Nikola JokićPlayer Note", "DEN - C", "65", "1", "1", "97%", "34:51", "9.9/17.4", ".569", "6.1/7.4", ".831", "1.7", "27.7", "12.9", "10.7", "1.4", "0.8", "3.7",
  "Shai Gilgeous-AlexanderNew Player Note", "OKC - PG", "68", "4", "2", "97%", "33:13", "10.8/19.4", ".553", "7.9/9.0", ".879", "1.7", "31.1", "4.3", "6.6", "1.4", "0.8", "2.2",
  "Anthony EdwardsNew Player Note", "MIN - PG,SG", "61", "9", "10", "96%", "35:01", "9.9/20.2", ".489", "5.7/7.2", ".796", "3.4", "28.8", "5.0", "3.7", "1.4", "0.8", "2.9",
  "Trae YoungPlayer Note", "WAS - PG", "15", "18", "94", "93%", "25:36", "5.4/11.8", ".458", "5.3/6.5", ".825", "1.8", "17.9", "2.0", "8.0", "0.9", "0.1", "2.6",
  "Alperen ŞengünPlayer Note", "HOU - PF,C", "72", "22", "33", "96%", "33:18", "8.1/15.6", ".519", "3.6/5.2", ".691", "0.6", "20.4", "8.9", "6.2", "1.2", "1.1", "3.2",
  "Evan MobleyNo new player Notes", "CLE - PF,C", "65", "27", "40", "95%", "31:54",
  "Jalen BrunsonPlayer Note", "NYK - PG", "74", "29", "37",
  "Donovan ClinganNew Player Note", "POR - C", "77", "44", "27",
  "Desmond BanePlayer Note", "ORL - SG,SF", "82", "48", "30",
  "N. Alexander-WalkerPlayer Note", "ATL - PG,SG", "78", "58", "-",
  "Pascal SiakamNo new player Notes", "IND - PF,C", "62", "59", "-",
  "Julius RandlePlayer Note", "BKN - PF", "79", "71", "-",
  "Miles BridgesQNew Player Note", "PHX - PF", "77", "101", "-",
  "Jalen GreenNew Player Note", "PHX - SG,SF", "32", "122", "-",
  "Cameron JohnsonPlayer Note", "DEN - SF,PF", "54", "146", "-",
  "Saddiq BeyPlayer Note", "NOP - SF,PF", "72", "151", "62",
  "Maxime RaynaudPlayer Note", "SAC - C", "74", "161", "125",
].join("\n");

{
  const names = I.parseOneRoster(REAL_ROSTER);
  eq(names.length, 17, "ROSTER: 17 players parsed");
  eq(names[0], "Nikola Jokić", "ROSTER: name + 'Player Note' stripped, diacritic kept");
  eq(names[1], "Shai Gilgeous-Alexander", "ROSTER: 'New Player Note' stripped");
  eq(names[5], "Evan Mobley", "ROSTER: 'No new player Notes' stripped");
  eq(names[12], "Miles Bridges", "ROSTER: trailing Q injury tag stripped");
  eq(names[9], "N. Alexander-Walker", "ROSTER: abbreviated name preserved");
  eq(names[16], "Maxime Raynaud", "ROSTER: last player");
  check(!names.some((n) => /Note/i.test(n)), "ROSTER: no 'Note' leaked into any name");
  check(!names.some((n) => /^\d/.test(n)), "ROSTER: no stat line misread as a name");
}

// --- stripRosterNoteSuffix unit cases ---
eq(I.stripRosterNoteSuffix("Nikola JokićPlayer Note"), "Nikola Jokić", "strip: Player Note");
eq(I.stripRosterNoteSuffix("Miles BridgesQNew Player Note"), "Miles Bridges", "strip: Q + New Player Note");
eq(I.stripRosterNoteSuffix("Evan MobleyNo new player Notes"), "Evan Mobley", "strip: No new player Notes");

// --- isBareTeamPosLine ---
check(I.isBareTeamPosLine("DEN - C") === true, "teampos: DEN - C");
check(I.isBareTeamPosLine("ATL - PG,SG") === true, "teampos: multi position");
check(I.isBareTeamPosLine("Nikola Jokić") === false, "teampos: name is not teampos");
check(I.isBareTeamPosLine("97%") === false, "teampos: stat is not teampos");

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) { console.log("\n" + fails.join("\n")); process.exit(1); }
