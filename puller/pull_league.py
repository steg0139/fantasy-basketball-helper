#!/usr/bin/env python3
"""
Pull Yahoo fantasy basketball draft results + end-of-season rosters and export a
league.json for the keeper calculator (index.html).

You run this once per season, after the season ends. Your league-mates never touch
Yahoo auth -- they just load the league.json this produces.

Setup (one time):
  1. Register a Yahoo app at https://developer.yahoo.com/apps/create/
       - Application Type: Installed Application (or Web; see redirect note below)
       - API Permissions: Fantasy Sports -> Read
     Yahoo gives you a Client ID (Consumer Key) and Client Secret (Consumer Secret).
  2. pip install -r requirements.txt
  3. Create oauth2.json next to this script (see oauth2.example.json), filling in your
     consumer_key / consumer_secret.
  4. Run it:
       python pull_league.py --league-key 428.l.123456
     On first run a browser/console prompt completes the Yahoo login + consent. The
     resulting tokens are cached back into oauth2.json so later runs are non-interactive.

Finding your league key:
  Run with --list-leagues to print the NBA leagues on your account and their keys.
  A league key looks like "428.l.123456" (the "428" is the NBA game id for the season).

Output:
  league.json (same folder by default, or --out PATH). Copy it next to index.html.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

try:
    from yahoo_oauth import OAuth2
except ImportError:
    sys.exit(
        "Missing dependency 'yahoo_oauth'. Run: pip install -r requirements.txt"
    )

API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OAUTH = os.path.join(HERE, "oauth2.json")


class YahooApiError(Exception):
    """Raised by api_get(..., _no_exit=True) so callers can try fallbacks."""


def get_session(oauth_file):
    if not os.path.exists(oauth_file):
        sys.exit(
            f"OAuth credentials file not found: {oauth_file}\n"
            "Copy oauth2.example.json to oauth2.json and fill in your consumer key/secret."
        )
    oauth = OAuth2(None, None, from_file=oauth_file)
    if not oauth.token_is_valid():
        oauth.refresh_access_token()
    return oauth


def api_get(oauth, path, params=None, _no_exit=False):
    """GET a Fantasy API resource as JSON. Retries once on token expiry.

    If _no_exit is True, raises YahooApiError instead of exiting the process, so
    callers can try alternative endpoints.
    """
    params = dict(params or {})
    params["format"] = "json"
    url = f"{API_BASE}/{path}"
    for attempt in range(2):
        if not oauth.token_is_valid():
            oauth.refresh_access_token()
        resp = oauth.session.get(url, params=params)
        if resp.status_code == 401 and attempt == 0:
            oauth.refresh_access_token()
            continue
        if resp.status_code != 200:
            msg = f"Yahoo API error {resp.status_code} for {url}\n{resp.text[:1000]}"
            if _no_exit:
                raise YahooApiError(msg)
            sys.exit(msg)
        try:
            return resp.json()
        except ValueError:
            msg = f"Non-JSON response from {url}:\n{resp.text[:1000]}"
            if _no_exit:
                raise YahooApiError(msg)
            sys.exit(msg)
    raise RuntimeError("unreachable")


# ---------------------------------------------------------------------------
# Yahoo's JSON is notoriously awkward: collections come back as objects keyed by
# numeric strings ("0", "1", ...) plus a "count", and each element is often a list
# of single-key dicts that must be merged. These helpers normalize that.
# ---------------------------------------------------------------------------

def _iter_numbered(container):
    """Yield values from Yahoo's {"0": {...}, "1": {...}, "count": N} shape."""
    if not isinstance(container, dict):
        return
    for key, val in container.items():
        if key == "count":
            continue
        if key.isdigit():
            yield val


def _merge_fragments(fragments):
    """Yahoo represents one entity as a list of single-key dicts (and sometimes
    nested lists). Flatten/merge them into a single dict."""
    merged = {}

    def absorb(item):
        if isinstance(item, dict):
            merged.update(item)
        elif isinstance(item, list):
            for sub in item:
                absorb(sub)

    absorb(fragments)
    return merged


def list_leagues(oauth):
    """Print NBA leagues on the authenticated account."""
    # game_codes=nba limits to basketball across seasons the user has played.
    # Yahoo returns 403 for the "users;use_login=1/games;game_codes=nba/leagues"
    # form for many apps. Querying all games (no game_codes filter) and filtering
    # client-side is far more reliable. We try a few endpoint shapes in order.
    endpoints = [
        "users;use_login=1/games/leagues",
        "users;use_login=1/games;game_codes=nba/leagues",
    ]
    data = None
    last_err = None
    for ep in endpoints:
        try:
            data = api_get(oauth, ep, _no_exit=True)
            if data is not None:
                break
        except Exception as e:  # pragma: no cover - network/runtime guard
            last_err = e
    if data is None:
        sys.exit(
            "Couldn't list leagues (Yahoo returned errors for every known endpoint).\n"
            f"Last error: {last_err}\n"
            "If you know your league key you can skip listing and run with --league-key directly."
        )

    fc = data.get("fantasy_content", {})
    users = fc.get("users", {})
    found = []
    for user in _iter_numbered(users):
        user = _merge_fragments(user.get("user", user))
        games = user.get("games", {})
        for game in _iter_numbered(games):
            game = _merge_fragments(game.get("game", game))
            game_code = game.get("code")  # "nba", "nfl", etc.
            leagues = game.get("leagues", {})
            for lg in _iter_numbered(leagues):
                lg = _merge_fragments(lg.get("league", lg))
                key = lg.get("league_key")
                name = lg.get("name")
                season = lg.get("season")
                if key:
                    found.append((key, name, season, game_code))

    nba = [f for f in found if f[3] == "nba"]
    show = nba if nba else found
    if not show:
        print("No leagues found on this account.")
        return
    print(("NBA leagues" if nba else "Leagues (couldn't filter to NBA)") + " on this account:")
    for key, name, season, code in show:
        tag = "" if nba else f"  [{code}]"
        print(f"  {key}   {season}   {name}{tag}")


def get_league_settings(oauth, league_key):
    data = api_get(oauth, f"league/{league_key}/settings")
    fc = data.get("fantasy_content", {})
    league = fc.get("league", [])
    merged = _merge_fragments(league)
    name = merged.get("name", "League")
    season = merged.get("season")
    num_teams = merged.get("num_teams")
    # draft rounds: Yahoo doesn't always expose this directly; infer later from draft.
    return {
        "name": name,
        "season": int(season) if season else None,
        "num_teams": int(num_teams) if num_teams else None,
    }


def get_draft_results(oauth, league_key):
    """Return dict playerId -> {round, pick} from the league draft."""
    data = api_get(oauth, f"league/{league_key}/draftresults")
    fc = data.get("fantasy_content", {})
    league = fc.get("league", [])
    merged = _merge_fragments(league)
    draft_results = merged.get("draftresults", {})
    out = {}
    for dr in _iter_numbered(draft_results):
        dr = _merge_fragments(dr.get("draft_result", dr))
        pid = dr.get("player_key", "").split(".")[-1] or dr.get("player_id")
        rnd = dr.get("round")
        pick = dr.get("pick")
        if pid and rnd:
            out[str(pid)] = {"round": int(rnd), "pick": int(pick) if pick else None}
    return out


def get_teams(oauth, league_key):
    """Return list of {teamKey, teamId, name}."""
    data = api_get(oauth, f"league/{league_key}/teams")
    fc = data.get("fantasy_content", {})
    league = fc.get("league", [])
    merged = _merge_fragments(league)
    teams = merged.get("teams", {})
    out = []
    for t in _iter_numbered(teams):
        t = _merge_fragments(t.get("team", t))
        key = t.get("team_key")
        tid = t.get("team_id")
        name = t.get("name")
        if key:
            out.append({"teamKey": key, "teamId": str(tid), "name": name})
    return out


def get_team_roster(oauth, team_key):
    """Return list of {playerId, name} for the team's current (end-of-season) roster."""
    data = api_get(oauth, f"team/{team_key}/roster")
    fc = data.get("fantasy_content", {})
    team = fc.get("team", [])
    merged = _merge_fragments(team)
    roster = merged.get("roster", {})
    roster = _merge_fragments(roster) if isinstance(roster, list) else roster
    players = roster.get("players", {})
    out = []
    for p in _iter_numbered(players):
        p = _merge_fragments(p.get("player", p))
        pid = p.get("player_key", "").split(".")[-1] or p.get("player_id")
        name = p.get("name", {})
        full = name.get("full") if isinstance(name, dict) else name
        if pid:
            out.append({"playerId": str(pid), "name": full})
    return out


def get_player_names(oauth, league_key, player_ids):
    """Resolve names for drafted players not otherwise known, batched 25 at a time."""
    names = {}
    ids = list(player_ids)
    game_prefix = league_key.split(".l.")[0]  # e.g. "428"
    for i in range(0, len(ids), 25):
        batch = ids[i : i + 25]
        keys = ",".join(f"{game_prefix}.p.{pid}" for pid in batch)
        data = api_get(oauth, f"league/{league_key}/players;player_keys={keys}")
        fc = data.get("fantasy_content", {})
        league = _merge_fragments(fc.get("league", []))
        players = league.get("players", {})
        for p in _iter_numbered(players):
            p = _merge_fragments(p.get("player", p))
            pid = p.get("player_key", "").split(".")[-1] or p.get("player_id")
            name = p.get("name", {})
            full = name.get("full") if isinstance(name, dict) else name
            if pid:
                names[str(pid)] = full
        time.sleep(0.1)  # be polite to the API
    return names


def build_league_json(oauth, league_key, rounds, fa_start):
    print(f"Fetching settings for {league_key} ...")
    settings = get_league_settings(oauth, league_key)

    print("Fetching draft results ...")
    draft_raw = get_draft_results(oauth, league_key)

    print("Fetching teams ...")
    teams = get_teams(oauth, league_key)

    print(f"Fetching rosters for {len(teams)} teams ...")
    name_cache = {}
    for team in teams:
        roster = get_team_roster(oauth, team["teamKey"])
        team["roster"] = roster
        for pl in roster:
            if pl.get("name"):
                name_cache[pl["playerId"]] = pl["name"]
        time.sleep(0.1)

    # Resolve names for any drafted players we don't have names for yet.
    missing = [pid for pid in draft_raw if pid not in name_cache]
    if missing:
        print(f"Resolving names for {len(missing)} drafted players ...")
        name_cache.update(get_player_names(oauth, league_key, missing))

    draft = {}
    for pid, info in draft_raw.items():
        draft[pid] = {
            "name": name_cache.get(pid),
            "round": info["round"],
            "pick": info["pick"],
        }

    # Infer rounds from the draft if not supplied.
    if rounds is None:
        rounds = max((d["round"] for d in draft.values()), default=15)

    season = settings.get("season")
    return {
        "meta": {
            "leagueKey": league_key,
            "leagueName": settings.get("name"),
            "season": season,
            "nextSeason": (season + 1) if season else None,
            "rounds": rounds,
            "faCostStartRound": fa_start,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "teams": teams,
        "draft": draft,
    }


def main():
    ap = argparse.ArgumentParser(description="Export Yahoo fantasy keeper data to league.json")
    ap.add_argument("--league-key", help="e.g. 428.l.123456")
    ap.add_argument("--list-leagues", action="store_true", help="List NBA leagues on your account and exit")
    ap.add_argument("--rounds", type=int, default=None, help="Draft rounds (default: inferred from draft, usually 15)")
    ap.add_argument("--fa-start", type=int, default=8, help="Cheapest FA keeper cost round (default 8)")
    ap.add_argument("--oauth", default=DEFAULT_OAUTH, help="Path to oauth2.json")
    ap.add_argument("--out", default=os.path.join(HERE, "league.json"), help="Output path")
    args = ap.parse_args()

    oauth = get_session(args.oauth)

    if args.list_leagues:
        list_leagues(oauth)
        return

    if not args.league_key:
        ap.error("--league-key is required (or use --list-leagues to find it)")

    data = build_league_json(oauth, args.league_key, args.rounds, args.fa_start)

    with open(args.out, "w") as f:
        json.dump(data, f, indent=2)

    n_players = sum(len(t.get("roster", [])) for t in data["teams"])
    print(
        f"\nWrote {args.out}\n"
        f"  league: {data['meta']['leagueName']} ({data['meta']['season']})\n"
        f"  teams: {len(data['teams'])}, drafted players: {len(data['draft'])}, "
        f"rostered players: {n_players}, rounds: {data['meta']['rounds']}\n"
        f"Copy this file next to index.html and open the page."
    )


if __name__ == "__main__":
    main()
