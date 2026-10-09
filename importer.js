/*
 * Paste-based importer for building league.json without the Yahoo API.
 *
 * Yahoo's API is behind an approval wall as of mid-2026, so this lets you paste
 * text copied from the Yahoo web UI (draft results + each team's roster) and turns
 * it into the same league.json structure the puller would have produced.
 *
 * The parsers are deliberately forgiving: Yahoo's copy formats vary, so we extract
 * what we need (round numbers, player names, team groupings) and tolerate the
 * surrounding noise (pick numbers, position/team tags, manager names).
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Importer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Strip a trailing parenthetical/tag like "(OKC - PG,SG)" or " - DEN - C".
  function cleanName(raw) {
    let s = raw.trim();
    // Remove trailing "(...)" groups.
    s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    // Remove "Player Note" artifacts Yahoo sometimes appends.
    s = s.replace(/\bplayer note\b/gi, "").trim();
    // Remove a trailing " - TEAM - POS" style tail (dashes with short tokens).
    s = s.replace(/\s*[-–]\s*[A-Z]{2,4}\s*[-–].*$/, "").trim();
    // Collapse whitespace.
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  // Does this token look like a player name (has a letter, not pure number/tag)?
  function looksLikeName(s) {
    if (!s) return false;
    if (!/[A-Za-z]/.test(s)) return false;
    // Reject pure position/team codes.
    if (/^[A-Z]{1,4}([,/][A-Z]{1,4})*$/.test(s.trim())) return false;
    return true;
  }

  function isTeamPosLine(s) {
    // "(DEN - C)", "(LAL - PG,SG)", "(PHI - SG,SF,PF)"
    return /^\([A-Za-z0-9/.\s-]+\s[-–]\s[A-Z,/]+\)$/.test(s.trim());
  }

  function isRoundHeader(s) {
    return /^round\s+\d{1,2}\b/i.test(s.trim());
  }

  function isBlankish(s) {
    const t = s.replace(/\u00a0/g, " ").trim();
    return t === "";
  }

  // "1.\tNikola Jokić" or "1. Nikola Jokić" or "1 Nikola Jokić" -> {pick, name}
  // Also bare "1." / "1" with the name on the following line (name === "").
  function matchPickLine(s) {
    const m = s.match(/^\s*(\d{1,3})[.)]?\s*(?:\t|\s)?\s*(.*)$/);
    if (!m) return null;
    const pick = parseInt(m[1], 10);
    const name = cleanName(m[2] || "");
    return { pick, name };
  }

  /**
   * Parse the real Yahoo "Draft Results" copy format, which is a repeating
   * multi-line record:
   *
   *   Round 1              <- header (round 1 may be implicit / missing)
   *   1.\tNikola Jokić     <- pick number + player name (tab or spaces between)
   *   (DEN - C)            <- team - positions  (ignored for keeper cost)
   *   Why so serious?      <- the drafting MANAGER / fantasy team name (the owner)
   *   2.\tVictor Wembanyama
   *   ...
   *
   * Returns { results: [{round, pick, name, manager}], warnings }.
   * `manager` is the fantasy team that drafted the player (used to build rosters).
   *
   * This also still handles simpler single-line formats (R1 P3 Player, 1.03 Player,
   * pipe/tab columns) via a fallback, so older pastes keep working.
   */
  function parseYahooDraft(text) {
    const results = [];
    const warnings = [];
    if (!text || !text.trim()) return { results, warnings };

    const lines = text.split(/\r?\n/);
    let round = 1;          // round 1 header is often absent; default to 1
    let sawAnyHeader = false;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (isBlankish(line)) { i++; continue; }

      if (isRoundHeader(line)) {
        round = parseInt(line.trim().match(/^round\s+(\d{1,2})/i)[1], 10);
        sawAnyHeader = true;
        i++;
        continue;
      }

      const pm = matchPickLine(line);
      if (pm) {
        let name = pm.name;
        let j = i + 1;

        // Name might be on the next non-blank line if the pick line had no name.
        if (!name) {
          while (j < lines.length && isBlankish(lines[j])) j++;
          if (j < lines.length && !isTeamPosLine(lines[j]) && !isRoundHeader(lines[j]) && !matchPickLine(lines[j])) {
            name = cleanName(lines[j]);
            j++;
          }
        }

        // Optional "(TEAM - POS)" line.
        while (j < lines.length && isBlankish(lines[j])) j++;
        if (j < lines.length && isTeamPosLine(lines[j])) {
          j++;
        }

        // Optional manager/owner line: the next non-blank line that is NOT the
        // start of the next pick record, a round header, or a team/pos line.
        let manager = null;
        let k = j;
        while (k < lines.length && isBlankish(lines[k])) k++;
        if (
          k < lines.length &&
          !isRoundHeader(lines[k]) &&
          !isTeamPosLine(lines[k]) &&
          !matchPickLine(lines[k])
        ) {
          manager = lines[k].trim();
          k++;
        }

        if (looksLikeName(name)) {
          results.push({ round, pick: pm.pick, name, manager });
        } else {
          warnings.push('Skipped a pick with no readable name near line: "' + line.trim() + '"');
        }
        i = k;
        continue;
      }

      // Unrecognized line; skip it.
      i++;
    }

    return { results, warnings };
  }

  /**
   * Parse the tab-separated draft format:
   *
   *   Round 1
   *   1\tNikola Jokić\tWhy so serious?
   *   2\tVictor Wembanyama\tWemby FMVP *
   *   ...
   *
   * Each pick is a single line: "<pick>.\t<player>\t<manager>", with "Round N"
   * headers between rounds and blank/nbsp separator lines. Returns
   * { results: [{round, pick, name, manager}], warnings }.
   */
  function parseTabDraft(text) {
    const results = [];
    const warnings = [];
    if (!text || !text.trim()) return { results, warnings };

    let round = 1;
    for (const raw of text.split(/\r?\n/)) {
      if (isBlankish(raw)) continue;
      if (isRoundHeader(raw)) {
        round = parseInt(raw.trim().match(/^round\s+(\d{1,2})/i)[1], 10);
        continue;
      }
      // Split on tabs (collapse repeated tabs). Expect [pick, name, manager].
      const cols = raw.split(/\t+/).map((c) => c.trim()).filter((c) => c !== "");
      if (cols.length < 2) {
        // Not a tab row; skip quietly (could be a stray header).
        continue;
      }
      const pickMatch = cols[0].match(/^(\d{1,3})[.)]?$/);
      let pick = null;
      let nameIdx = 0;
      if (pickMatch) {
        pick = parseInt(pickMatch[1], 10);
        nameIdx = 1;
      }
      const name = cleanName(cols[nameIdx] || "");
      const manager = cols[nameIdx + 1] != null ? cols[nameIdx + 1].trim() : null;
      if (looksLikeName(name)) {
        results.push({ round, pick, name, manager });
      } else {
        warnings.push('Skipped unparsable draft line: "' + raw.trim() + '"');
      }
    }
    return { results, warnings };
  }

  /**
   * Parse pasted draft results into [{ round, pick, name, manager? }].
   *
   * Detects which Yahoo copy format was pasted:
   *   - tab-separated single line ("1\tPlayer\tManager")  -> parseTabDraft
   *   - multi-line with "(TEAM - POS)" lines              -> parseYahooDraft
   *   - simpler single-line formats                       -> parseDraftSingleLine
   */
  function parseDraft(text) {
    const lines = (text || "").split(/\r?\n/);

    // Tab-separated: a data line (not a header) that contains a tab.
    const hasTabRows = lines.some(
      (l) => !isRoundHeader(l) && !isBlankish(l) && /\t/.test(l)
    );
    // Multi-line Yahoo: standalone "(TEAM - POS)" lines present.
    const hasTeamPosLines = lines.some((l) => isTeamPosLine(l));

    if (hasTabRows && !hasTeamPosLines) {
      return parseTabDraft(text);
    }
    if (hasTeamPosLines) {
      return parseYahooDraft(text);
    }
    return parseDraftSingleLine(text);
  }

  /**
   * Legacy single-line parser (kept for simpler pastes and tests).
   */
  function parseDraftSingleLine(text) {
    const results = [];
    const warnings = [];
    if (!text || !text.trim()) return { results, warnings };

    const lines = text.split(/\r?\n/);
    let headerRound = null;
    let autoPickInRound = 0;

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // "Round N" header (optionally "Round N (snake)" etc).
      const hdr = line.match(/^round\s+(\d{1,2})\b/i);
      if (hdr && !/\d.*[A-Za-z]{3,}/.test(line.replace(/^round\s+\d+/i, ""))) {
        // A header line that is essentially just "Round N" with no player.
        headerRound = parseInt(hdr[1], 10);
        autoPickInRound = 0;
        continue;
      }

      let round = null;
      let pick = null;
      let rest = line;

      // Column-separated (tab or pipe): try to read leading numeric columns.
      if (/[|\t]/.test(line)) {
        const cols = line.split(/\s*[|\t]\s*/).map((c) => c.trim()).filter(Boolean);
        // Find the first column that looks like a name.
        const nameIdx = cols.findIndex(looksLikeName);
        if (nameIdx > 0) {
          // Numeric columns before the name: [round, pick] or [pick].
          const nums = cols.slice(0, nameIdx).map((c) => c.match(/\d+/)).filter(Boolean).map((m) => parseInt(m[0], 10));
          if (nums.length >= 2) { round = nums[0]; pick = nums[1]; }
          else if (nums.length === 1) { pick = nums[0]; }
          rest = cols[nameIdx];
          const name = cleanName(rest);
          if (round == null) round = headerRound;
          if (round != null && looksLikeName(name)) {
            results.push({ round, pick, name });
            continue;
          }
        }
      }

      // Inline "R1 P3", "Rd1", "1.03", "1-03", "Pick 1.3 ..."
      let m =
        rest.match(/^\s*(?:pick\s*)?r(?:d|ound)?\.?\s*(\d{1,2})\b[\s.\-]*p?(\d{1,3})?\b\s*[:.\-)]?\s*(.*)$/i) ||
        rest.match(/^\s*(\d{1,2})\s*[.\-]\s*(\d{1,3})\s+(.*)$/);
      if (m) {
        round = parseInt(m[1], 10);
        pick = m[2] ? parseInt(m[2], 10) : null;
        rest = m[3];
      } else {
        // Leading bare pick number then name: "3 Player Name" (uses headerRound).
        const m2 = rest.match(/^\s*(\d{1,3})\s+(.*)$/);
        if (m2 && headerRound != null) {
          pick = parseInt(m2[1], 10);
          rest = m2[2];
          round = headerRound;
        }
      }

      if (round == null) round = headerRound;

      const name = cleanName(rest);
      if (round != null && looksLikeName(name)) {
        if (pick == null) pick = ++autoPickInRound;
        results.push({ round, pick, name });
      } else if (looksLikeName(name)) {
        warnings.push('Couldn\'t determine a round for: "' + name + '"');
      }
    }

    return { results, warnings };
  }

  /**
   * Parse team rosters. Input is one or more team blocks. A team block starts with
   * a line beginning "Team:" or "=== Name ===" or a line that is just a name
   * followed by player lines. We keep it simple: blocks are separated by blank
   * lines OR by a "Team:"/header marker; the first line of a block is the team name.
   *
   * Returns [{ name, players: [playerName, ...] }].
   */
  function parseRosters(text) {
    const teams = [];
    const warnings = [];
    if (!text || !text.trim()) return { teams, warnings };

    // Split into blocks on blank lines.
    const blocks = text
      .split(/\r?\n\s*\r?\n/)
      .map((b) => b.trim())
      .filter(Boolean);

    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;

      let teamName = lines[0];
      let playerLines = lines.slice(1);

      // Normalize explicit markers.
      teamName = teamName
        .replace(/^team\s*[:\-]\s*/i, "")
        .replace(/^=+\s*/, "")
        .replace(/\s*=+$/, "")
        .trim();

      // If the "name" line itself looks like a player and there's no clear header,
      // treat the whole block as players under an auto name.
      const players = [];
      for (const pl of playerLines) {
        const n = cleanName(pl);
        if (looksLikeName(n)) players.push(n);
      }
      if (!players.length) {
        warnings.push('Team block for "' + teamName + '" had no players.');
      }
      teams.push({ name: teamName || "Team " + (teams.length + 1), players });
    }

    return { teams, warnings };
  }

  // Roster position-slot labels in the lineup view.
  var POS_SLOTS = ["PG", "SG", "SF", "PF", "G", "F", "C", "Util", "BN", "IL+", "IL", "GTD", "NA"];
  function isPosSlotLine(s) {
    return POS_SLOTS.indexOf(s.trim()) !== -1;
  }
  // A game-result line like "W, 132-126 vs NOP" or "L, 106-126 @ CLE".
  function isGameResultLine(s) {
    return /^[WL],\s*\d+-\d+\s+(vs|@)\s+[A-Z]{2,3}$/.test(s.trim());
  }

  /**
   * Parse the Yahoo lineup/roster view that looks like:
   *
   *   Pos
   *   Player
   *   PG            <- position slot label
   *   Ayo Dosunmu   <- player name
   *   W, 132-126 vs NOP   <- last game result
   *   SG
   *   Bub Carrington
   *   ...
   *   SF
   *   (Empty)       <- empty slot, skipped
   *
   * The reliable anchor: a position-slot label line is immediately followed by the
   * player name on the next line. "(Empty)" slots are skipped. Returns player names.
   */
  function parseLineupRoster(text) {
    const names = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (isPosSlotLine(lines[i])) {
        const candidate = (lines[i + 1] || "").trim();
        if (!candidate || /^\(empty\)$/i.test(candidate)) continue;
        if (isPosSlotLine(candidate) || isGameResultLine(candidate)) continue;
        const name = cleanName(candidate);
        if (looksLikeName(name)) names.push(name);
      }
    }
    return names;
  }

  /**
   * Parse ONE team's roster paste into a list of player names, auto-detecting the
   * format: the lineup view (Pos-slot + name + game result), the rich stat view
   * (name + "TEAM - POS" + stats), or a plain one-name-per-line list. The team name
   * is supplied separately by the caller.
   */
  function parseOneRoster(text) {
    if (!text || !text.trim()) return [];
    const lines = text.split(/\r?\n/);
    const hasPosSlots = lines.some((l) => isPosSlotLine(l));
    const hasBareTeamPos = lines.some((l) => isBareTeamPosLine(l));
    if (hasPosSlots && !hasBareTeamPos) {
      return parseLineupRoster(text);
    }
    if (hasBareTeamPos) {
      return parseYahooRoster(text);
    }
    // Fallback: plain list, one name per line (strip team/pos parentheses if present).
    const out = [];
    for (const l of lines) {
      const n = cleanName(l);
      if (looksLikeName(n)) out.push(n);
    }
    return out;
  }

  /**
   * Parse a multi-team roster paste where each team block is introduced by a
   * "TEAM: <name>" line. Returns [{ name, players: [...] }], using parseOneRoster
   * on each block so all roster formats are supported.
   */
  function parseLabeledRosters(text) {
    const teams = [];
    if (!text || !text.trim()) return teams;
    const lines = text.split(/\r?\n/);
    let current = null;
    let buf = [];
    const flush = () => {
      if (current != null) {
        teams.push({ name: current, players: parseOneRoster(buf.join("\n")) });
      }
      buf = [];
    };
    for (const line of lines) {
      const m = line.match(/^\s*TEAM:\s*(.+?)\s*$/i);
      if (m) {
        flush();
        current = m[1].trim();
      } else {
        buf.push(line);
      }
    }
    flush();
    return teams;
  }

  // A "TEAM - POS" line WITHOUT parentheses, as seen in the roster paste:
  // "DEN - C", "ATL - PG,SG", "HOU - PF,C". Team code may contain a dot (none seen
  // but tolerate it). This is the anchor that identifies the preceding line as a name.
  function isBareTeamPosLine(s) {
    return /^[A-Za-z][A-Za-z.]{1,4}\s[-–]\s[A-Z]{1,2}(?:[,/][A-Z]{1,2})*$/.test(s.trim());
  }

  // Strip the glued-on note/injury suffixes from a roster name line:
  // "Nikola JokićPlayer Note" -> "Nikola Jokić"
  // "Miles BridgesQNew Player Note" -> "Miles Bridges"
  // "Evan MobleyNo new player Notes" -> "Evan Mobley"
  function stripRosterNoteSuffix(s) {
    let t = s.trim();
    // Remove the note phrase at the end (order matters: longest/specific first).
    t = t.replace(/(No new player Notes?|New Player Note|Player Note|Notes?)\s*$/i, "");
    // Remove a trailing injury designation letter glued on (Q, O, D, GTD, etc.)
    // but only a single uppercase letter or short tag right before where the note was.
    t = t.replace(/(?:GTD|OUT|DTD|[QODP])\s*$/, function (m) {
      // Only strip if it's a lone tag, not part of a real word; names rarely end in
      // a lone capital, so this is safe after the note has been removed.
      return "";
    });
    return t.replace(/\s+/g, " ").trim();
  }

  /**
   * Parse a Yahoo "roster" paste (the My Team / team roster view), which looks like:
   *
   *   Nikola JokićPlayer Note      <- name (+ glued note/injury suffix)
   *   DEN - C                      <- team - positions (no parentheses)
   *   65                           <- ~16 stat lines, skipped
   *   1
   *   ...
   *   Shai Gilgeous-AlexanderNew Player Note
   *   OKC - PG
   *   ...
   *
   * The anchor is the "TEAM - POS" line: the line immediately before it is the player
   * name. Everything else is skipped. Returns an array of player names in order.
   */
  function parseYahooRoster(text) {
    const names = [];
    if (!text || !text.trim()) return names;
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (isBareTeamPosLine(lines[i])) {
        const name = stripRosterNoteSuffix(lines[i - 1]);
        if (looksLikeName(name)) names.push(name);
      }
    }
    return names;
  }

  // Normalize a name for matching draft<->roster (case/punctuation/diacritics).
  function normKey(name) {
    return String(name)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[.'`’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Combine parsed draft + rosters into a league.json object.
   *
   * @param opts { leagueName, season, rounds, faCostStartRound,
   *               draftRows: [{round,pick,name,manager?}],
   *               rosterTeams: [{name,players[]}] }
   *
   * Two ways rosters get built:
   *   1. If `rosterTeams` is provided (the end-of-season roster paste), those are the
   *      authoritative keeper-eligible rosters. A rostered player not found in the
   *      draft is a free-agent keeper.
   *   2. Otherwise, if the draft rows carry a `manager` (the Yahoo draft paste includes
   *      the drafting fantasy team), rosters are reconstructed from who drafted whom.
   *      This is a convenient starting point but does NOT reflect in-season trades,
   *      drops, or waiver pickups — so a season-end roster paste is preferred.
   *
   * Players are keyed by a synthetic id derived from their normalized name, since the
   * paste path has no Yahoo player ids.
   */
  function buildLeagueJson(opts) {
    const rounds = opts.rounds || 15;
    const faStart = opts.faCostStartRound || 8;
    const draftRows = opts.draftRows || [];
    const rosterTeams = opts.rosterTeams || [];
    const warnings = [];

    // id for a name
    const idFor = (name) => "n:" + normKey(name);

    const draft = {};
    for (const row of draftRows) {
      const id = idFor(row.name);
      // If a name appears twice in the draft, keep the earliest round (shouldn't happen).
      if (!draft[id] || row.round < draft[id].round) {
        draft[id] = { name: row.name, round: row.round, pick: row.pick != null ? row.pick : null };
      }
    }

    let teams;
    let rosterSource;

    if (rosterTeams.length) {
      // End-of-season roster paste is authoritative.
      rosterSource = "roster-paste";
      teams = rosterTeams.map((t, i) => ({
        teamKey: "paste.t." + (i + 1),
        teamId: String(i + 1),
        name: t.name,
        roster: t.players.map((pname) => ({ playerId: idFor(pname), name: pname })),
      }));
    } else {
      // Reconstruct rosters from the draft's manager field, if present.
      const haveManagers = draftRows.some((r) => r.manager);
      if (haveManagers) {
        rosterSource = "draft-managers";
        const byManager = {};
        const order = [];
        for (const row of draftRows) {
          const mgr = row.manager || "Unassigned";
          if (!byManager[mgr]) { byManager[mgr] = []; order.push(mgr); }
          byManager[mgr].push({ playerId: idFor(row.name), name: row.name });
        }
        teams = order.map((mgr, i) => ({
          teamKey: "paste.t." + (i + 1),
          teamId: String(i + 1),
          name: mgr,
          roster: byManager[mgr],
        }));
        warnings.push(
          "Rosters were reconstructed from who DRAFTED each player. This ignores in-season " +
          "trades, drops, and free-agent pickups. Paste end-of-season rosters for accuracy."
        );
      } else {
        rosterSource = "none";
        teams = [];
        warnings.push("No rosters found. Paste end-of-season rosters (or a draft that includes team names).");
      }
    }

    // Note any rostered players not found in the draft (they'll be treated as FAs).
    const faNames = [];
    for (const t of teams) {
      for (const p of t.roster) {
        if (!draft[p.playerId]) faNames.push(p.name + " (" + t.name + ")");
      }
    }
    if (faNames.length) {
      warnings.push(
        faNames.length + " rostered player(s) not in the draft — treated as free-agent keepers (round " +
        faStart + " cost): " + faNames.slice(0, 8).join(", ") + (faNames.length > 8 ? "…" : "")
      );
    }

    return {
      league: {
        meta: {
          leagueKey: "paste." + (opts.season || "league"),
          leagueName: opts.leagueName || "My League",
          season: opts.season || null,
          nextSeason: opts.season ? opts.season + 1 : null,
          rounds,
          faCostStartRound: faStart,
          generatedAt: new Date().toISOString(),
          source: "paste-import",
          rosterSource: rosterSource,
        },
        teams,
        draft,
      },
      warnings,
    };
  }

  return {
    cleanName, looksLikeName, parseDraft, parseYahooDraft, parseTabDraft, parseRosters,
    parseOneRoster, parseYahooRoster, parseLineupRoster, parseLabeledRosters,
    stripRosterNoteSuffix, isBareTeamPosLine, isPosSlotLine,
    normKey, buildLeagueJson, isTeamPosLine, matchPickLine,
  };
});
