# league.json schema

This file is produced by `puller/pull_league.py` (pulled from Yahoo) and consumed by
`index.html` (the keeper calculator). The draft results and end-of-season rosters come
from Yahoo and should never be hand-edited. Traded pick inventory for next season is the
only data entered by hand, and that lives in the browser (localStorage), not in this file.

```json
{
  "meta": {
    "leagueKey": "428.l.123456",
    "leagueName": "My Hoops League",
    "season": 2025,
    "nextSeason": 2026,
    "rounds": 15,
    "faCostStartRound": 8,
    "generatedAt": "2026-10-08T00:00:00Z"
  },

  "teams": [
    {
      "teamKey": "428.l.123456.t.1",
      "teamId": "1",
      "name": "Team Awesome",

      "roster": [
        { "playerId": "5583", "name": "Nikola Jokic" }
      ]
    }
  ],

  "draft": {
    "5583": { "name": "Nikola Jokic", "round": 1, "pick": 3 }
  }
}
```

## Field notes

- `meta.rounds` — total draft rounds (15 for this league). Sets the bottom bound for
  FA cost bumping and the default pick inventory (1 pick per round, rounds 1..rounds).
- `meta.faCostStartRound` — the first (cheapest) FA keeper tier. 1 FA = this round,
  2 FAs = this round and one above, etc. (8, then 7, then 6...).
- `teams[].roster` — the team's end-of-season roster. These are the keeper-eligible
  players. Each entry references a `playerId` that may or may not appear in `draft`.
- `draft` — map of `playerId -> { name, round, pick }` for every player taken in the
  draft. Ownership is irrelevant for keeper cost; what matters is the round a player was
  drafted. A rostered player **not** present in `draft` was an undrafted free-agent add
  and uses the FA cost tiers.

## Derived (not stored here)

- **Base keeper cost** for a drafted player = `draftRound - 1`.
  A player drafted in round 1 has base cost "round 0", which is not keepable.
- **Base keeper cost** for an FA = assigned from `faCostStartRound` downward as more
  FAs are kept (handled by the calculator, since it depends on the chosen keeper set).
- **Pick inventory** per team defaults to one pick in each round `1..rounds`. Trades are
  applied by the user in the UI and persisted to localStorage, keyed by `teamKey`.
