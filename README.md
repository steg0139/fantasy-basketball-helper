# Keeper Cost Tracker

A tool for a Yahoo fantasy basketball keeper league to figure out what each player
would cost to keep next season, and whether a team has the draft capital to keep them.

## League rules this models

- Keep **3 to 7** players (minimum 3).
- A **drafted** player costs the pick **one round earlier** than they were drafted
  (drafted round 5 → costs your round 4 pick). It doesn't matter who drafted them;
  what matters is the round they were drafted. A player picked up off waivers keeps
  the round they were originally drafted in.
- A player drafted in **round 1 can't be kept**.
- **Free-agent adds** (undrafted) cost round 8, then 7, 6, ... as you keep more of them.
- **Picks can be traded**, so a team may own 0, 1, or several picks in a round.
- If two keepers would cost the same round, they use the picks you own in that round
  first; the excess **bumps up** to the next earlier round where you still have a pick
  (bumping makes a keeper more expensive). A round-1 pick **can** be consumed by a
  bumped keeper, even though you can't keep a round-1 player.
- If a keeper can't be placed on any owned pick, the set is flagged **not enough capital**.

## Getting your league data in: two paths

As of mid-2026, Yahoo put the Fantasy Sports API behind an approval program, so
self-serve API apps get a `403 "not authorized"` on every endpoint (OAuth still works,
but the data calls are blocked). Because of that there are two ways to load data:

1. **Paste importer (works today, no API).** Open `index.html`, choose **Paste from
   Yahoo**, and paste your draft results and each team's end-of-season roster copied
   from the Yahoo website. The page parses it, shows a preview, and you're off. You can
   also **Download league.json** from the preview to share the file so nobody else has
   to paste anything.

2. **Yahoo puller (if/when you get API access).** `puller/pull_league.py` fetches the
   same data automatically via OAuth and writes `league.json`. The script is complete
   and the OAuth flow works; it only fails right now because of Yahoo's access gate. If
   you're approved at `sports.yahoo.com/developer`, it should work as-is.

```
PASTE PATH:   paste draft + rosters  -->  importer.js  -->  league (in browser) --+
API PATH:     pull_league.py (OAuth)  -->  league.json  ---------------------------+--> keeper calculator
                                                                                        (index.html + keeper.js)
```

- **`league.json`** holds draft results and end-of-season rosters. See `SCHEMA.md`.
  Produced by either the importer (Download button) or the puller. Nobody hand-edits it.
- **`index.html`** is the shareable page. Load a `league.json`, or paste data once and
  it's saved in your browser so a refresh keeps it.
- **Traded picks** for next season are the only ongoing manual input, entered in the
  page and saved per team in the browser (localStorage).

## Using the paste importer

**Step 1 — Draft results.** Open your league's **Draft Results** page on Yahoo, select
the whole board, and copy it. In the page open **Paste from Yahoo**, fill in league name
/ season / rounds, and paste into **Draft results**. The parser handles Yahoo's real
multi-line layout (pick number + player on one line, `(TEAM - POS)` on the next, the
drafting manager on a third), as well as simpler one-line formats. Round-1 players are
flagged as non-keepable automatically.

**Step 2 — Rosters, one team at a time.** Open a team's roster on Yahoo and copy the
player list (stats and all — the parser ignores the stat columns). Paste it into the
roster box, type that team's name, and click **Add team**. Repeat for each team. The
parser strips Yahoo's glued-on note/injury tags (e.g. `Player Note`, `New Player Note`,
a trailing `Q`) and keeps diacritics. Any rostered player not found in the draft is
treated as a free-agent keeper (round-8 cost tier).

**Step 3.** Click **Preview** to check what was parsed (each player's keeper cost is
shown), then **Use this data**. Optionally **Download league.json** to share with the
league so nobody else has to paste anything.

Notes:
- Keeper costs are based on **end-of-season rosters**, which reflect trades, drops, and
  waiver pickups. If you skip Step 2 entirely, rosters are reconstructed from who
  *drafted* each player (a rough starting point only, and it misses free-agent pickups);
  the page warns you when that happens.
- Everything you import is saved in your browser, so a refresh keeps it.

## Using the page

1. Put `index.html`, `keeper.js`, and a `league.json` in the same folder.
2. Open the page (serve the folder over http, e.g. `python3 -m http.server`, since
   browsers block `fetch` of a local file over `file://`). Or use the file picker the
   page shows when it can't auto-load `league.json`.
3. Pick your team, adjust pick inventory for any trades, check 3–7 players.
4. Read the verdict, the rounds each keeper costs (with any bumps), and whether you
   have the capital.

To try it immediately without Yahoo, copy the included sample:

```
cp league.sample.json league.json
python3 -m http.server 8777
# open http://localhost:8777
```

## How your data is stored (and how to share it)

There are two separate kinds of data:

- **League data** (draft + rosters) is the same for everyone. When you import, it's
  saved in **your browser only** (localStorage) — that's just so a refresh doesn't lose
  your work. It does **not** travel to anyone else. To share it, you export one
  `league.json` file.
- **Per-person choices** (your traded-pick inventory and which players you checked as
  keepers) are private to each person and saved in their own browser, per team.

In-progress imports autosave too: if you're adding teams one at a time and the page
reloads, your draft text and the teams you've added so far come back. Once you click
**Use this data** (or **Download league.json**), that becomes the committed league and
the in-progress draft is cleared.

To share: after importing, click **Export league.json** (in the Team panel) or
**Download league.json** (in the importer). Distribute that one file — or, better, host
it (below) so nobody has to download anything.

## Share it with your league via GitHub Pages

The page is fully static, so GitHub Pages is the easiest host. A workflow at
`.github/workflows/pages.yml` publishes only the app files (`index.html`, `keeper.js`,
`importer.js`, and `league.json` if present) — the `puller/` folder and your OAuth
secret are never published.

One-time setup:

```
git init
git add .
git commit -m "Keeper tracker"
git branch -M main
git remote add origin https://github.com/<you>/fantasy-sports-helper.git
git push -u origin main
```

Then in the repo on GitHub: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The next push (or a manual run from the **Actions** tab) deploys the
site to `https://<you>.github.io/fantasy-sports-helper/`. Share that URL with your league.

To publish the league's data so it auto-loads for everyone (no file picking):

```
# after importing in the page, click Export league.json, then:
cp ~/Downloads/league.json ./league.json
git add league.json
git commit -m "Add 2025 league data"
git push
```

Each season, replace `league.json` and push again. Everyone's own pick/keeper choices
are kept in their browser and are unaffected.

> Note: `.gitignore` excludes `puller/oauth2.json` so your Yahoo secret never gets
> committed. Double-check it's not staged before your first push.

## Generating league.json from Yahoo (commissioner, once a season)

See `puller/pull_league.py` for full setup. Short version:

```
cd puller
pip install -r requirements.txt
cp oauth2.example.json oauth2.json   # fill in your Yahoo app client id/secret
python pull_league.py --list-leagues               # find your league key
python pull_league.py --league-key 428.l.123456    # writes league.json
cp league.json ..                                   # next to index.html
```

The first run opens a Yahoo login/consent prompt; tokens are cached so later runs are
non-interactive. Only the commissioner does this.

## Tests

```
node keeper.test.js            # engine unit tests
node importer.test.js          # paste parser + end-to-end into the engine
node ui.integration.test.js    # page data-flow against league.sample.json
```

## Notes / limitations

- Yahoo's API doesn't cleanly expose post-trade pick ownership, so traded picks are
  entered by hand in the page. Everything else (draft rounds, rosters) comes from Yahoo.
- The page is fully static. Host it anywhere (GitHub Pages, S3, a shared folder served
  over http) alongside `keeper.js` and `league.json`.
