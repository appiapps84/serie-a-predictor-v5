const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const TIMEOUT = 12000;

// Free plan: teniamoci molto sotto 100 req/min.
// 1 matches + 1 standings + 8 historical stats + 6 lineups = 16 max.
const MAX_HISTORICAL_STATS = 8;
const MAX_LINEUPS = 6;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getKey() {
  return process.env.BBS_API_KEY || "";
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function teamName(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    return (
      value.name ||
      value.team_name ||
      value.teamName ||
      value.short_name ||
      value.shortName ||
      null
    );
  }

  return null;
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.matches)) return payload.data.matches;
  if (Array.isArray(payload?.matches)) return payload.matches;

  return [];
}

function extractData(payload) {
  if (payload?.data !== undefined) return payload.data;
  return payload;
}

function getMatchId(match) {
  return (
    match?.id ||
    match?.match_id ||
    match?.matchId ||
    match?.fixture_id ||
    match?.fixtureId ||
    null
  );
}

function getKickoff(match) {
  return (
    match?.kickoff_utc ||
    match?.kickoffUtc ||
    match?.kickoff ||
    match?.start_time ||
    match?.startTime ||
    match?.date ||
    null
  );
}

function getStatus(match) {
  return normalizeText(
    match?.status ||
      match?.state ||
      match?.match_status ||
      match?.matchStatus ||
      ""
  );
}

function getHomeTeam(match) {
  return teamName(
    match?.home ||
      match?.home_team ||
      match?.homeTeam ||
      match?.teams?.home
  );
}

function getAwayTeam(match) {
  return teamName(
    match?.away ||
      match?.away_team ||
      match?.awayTeam ||
      match?.teams?.away
  );
}

function isFinished(match) {
  const status = getStatus(match);

  if (
    [
      "finished",
      "final",
      "ft",
      "completed",
      "complete",
      "ended",
    ].includes(status)
  ) {
    return true;
  }

  const score =
    match?.score ||
    match?.scores ||
    match?.final_score ||
    match?.finalScore;

  if (score && typeof score === "object") {
    const home =
      score.home ??
      score.home_score ??
      score.homeScore ??
      score?.full_time?.home;

    const away =
      score.away ??
      score.away_score ??
      score.awayScore ??
      score?.full_time?.away;

    if (home !== null && home !== undefined &&
        away !== null && away !== undefined) {
      return true;
    }
  }

  return false;
}

function isFuture(match) {
  const kickoff = getKickoff(match);

  if (!kickoff) return false;

  const time = Date.parse(kickoff);

  if (!Number.isFinite(time)) return false;

  return time > Date.now();
}

/**
 * Recursive search for xG fields.
 *
 * Supports shapes such as:
 * {
 *   home_xg: 1.43,
 *   away_xg: 0.82
 * }
 *
 * or:
 * {
 *   expected_goals: {
 *      home: 1.43,
 *      away: 0.82
 *   }
 * }
 *
 * or nested stats/groups/items structures.
 */


 *
 * or nested stats/groups/items structures.
 */


function collectInterestingKeys(node, output = new Set(), depth = 0) {
  if (node === null || node === undefined || depth > 8) {
    return output;
  }

  if (Array.isArray(node)) {
    for (const item of node.slice(0, 30)) {
      collectInterestingKeys(item, output, depth + 1);
    }
    return output;
  }

  if (typeof node !== "object") {
    return output;
  }

  for (const [key, value] of Object.entries(node)) {
    const normalized = normalizeText(key);

    if (
      normalized.includes("xg") ||
      normalized.includes("expected") ||
      normalized.includes("goal")
    ) {
      output.add(key);
    }

    collectInterestingKeys(value, output, depth + 1);
  }

  return output;
}

async function fetchJSON(path, key, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  try {
    const headers = {
      Authorization: `Bearer ${key}`,
      "X-API-Key": key,
      Accept: "application/json",
      ...(options.headers || {}),
    };

    const response = await fetch(`${BBS_BASE}${path}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    const retryAfter = response.headers.get("Retry-After");

    let body = null;

    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const error = new Error(
        `BBS ${response.status}: ${JSON.stringify(body)}`
      );

      error.status = response.status;
      error.body = body;
      error.retryAfter = retryAfter
        ? Number(retryAfter)
        : null;

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeError(error) {
  return {
    status: error?.status || null,
    message: error?.message || String(error),
    retryAfter: error?.retryAfter ?? null,
  };
}

async function safeFetch(path, key, diagnostics, label) {
  try {
    return await fetchJSON(path, key);
  } catch (error) {
    diagnostics.errors.push({
      label,
      path,
      ...sanitizeError(error),
    });

    return null;
  }
}

function buildHistoricalTeamXG(historicalRows) {
  const buckets = {};

  function add(team, xg) {
    if (!team || !Number.isFinite(xg)) return;

    const normalized = normalizeText(team);

    if (!normalized) return;

    if (!buckets[normalized]) {
      buckets[normalized] = {
        team,
        xg: [],
      };
    }

    buckets[normalized].xg.push(xg);
  }

  for (const row of historicalRows) {
    if (!row.xg) continue;

    const home = row.homeTeam;
    const away = row.awayTeam;

    if (home) add(home, row.xg.home);
    if (away) add(away, row.xg.away);
  }

  const result = {};

  for (const [normalized, bucket] of Object.entries(buckets)) {
    if (!bucket.xg.length) continue;

    const average =
      bucket.xg.reduce((sum, value) => sum + value, 0) /
      bucket.xg.length;

    result[bucket.team] = {
      xGPerMatch: Number(average.toFixed(3)),
      samples: bucket.xg.length,
    };
  }

  return result;
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const key = getKey();

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (!key) {
    return res.status(500).json({
      ok: false,
      error: "Missing BBS_API_KEY environment variable",
    });
  }

  const diagnostics = {
    apiKeyDetected: true,
    errors: [],
    historicalStatsChecked: 0,
    lineupsChecked: 0,
    xGSamples: [],
  };

  try {
    // ---------------------------------------------------------
    // 1. CURRENT MATCHES — 1 REQUEST
    // ---------------------------------------------------------

    const matchesPayload = await fetchJSON(
      `/v1/matches?sport=${SPORT}&league=${LEAGUE}&limit=50`,
      key
    );

    const matches = extractArray(matchesPayload);

    // ---------------------------------------------------------
    // 2. STANDINGS — 1 REQUEST
    // ---------------------------------------------------------

    const standingsPayload = await safeFetch(
      `/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
      key,
      diagnostics,
      "standings"
    );

    const standings = extractArray(standingsPayload);

    // ---------------------------------------------------------
    // 3. HISTORICAL MATCHES — NO MASSIVE HISTORY CALL
    // ---------------------------------------------------------

    const historicalPayload = await safeFetch(
      `/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}&status=finished&limit=20`,
      key,
      diagnostics,
      "historical_matches"
    );

    const historicalMatches = extractArray(historicalPayload);

    // ---------------------------------------------------------
    // 4. HISTORICAL xG
    //
    // Max 8 calls.
    // We only ask for finished matches.
    // ---------------------------------------------------------

    const historicalCandidates = historicalMatches
      .filter(isFinished)
      .slice(0, MAX_HISTORICAL_STATS);

    const historicalRows = [];

    for (const match of historicalCandidates) {
      const id = getMatchId(match);

      if (!id) continue;

      const statsPayload = await safeFetch(
        `/v1/stored/matches/${encodeURIComponent(id)}/stats`,
        key,
        diagnostics,
        "historical_stats"
      );

      diagnostics.historicalStatsChecked++;

      if (!statsPayload) continue;

      const xg = findXGValues(statsPayload);

      const row = {
        id,
        homeTeam: getHomeTeam(match),
        awayTeam: getAwayTeam(match),
        kickoff: getKickoff(match),
        xg: xg || null,
      };

      historicalRows.push(row);

      // Keep a tiny diagnostic sample, not the entire API response.
      if (diagnostics.xGSamples.length < 3) {
        diagnostics.xGSamples.push({
          id,
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          foundXG: !!xg,
          interestingKeys: Array.from(
            collectInterestingKeys(statsPayload)
          ).slice(0, 30),
        });
      }
    }

    const teamXG = buildHistoricalTeamXG(historicalRows);

    // ---------------------------------------------------------
    // 5. LINEUPS
    //
    // Only ask for a few upcoming matches.
    // BBS says confirmed lineups generally appear around 60 min
    // before kickoff, so querying every future fixture is wasteful.
    // ---------------------------------------------------------

    const upcoming = matches
      .filter(isFuture)
      .sort((a, b) => {
        const ta = Date.parse(getKickoff(a) || "");
        const tb = Date.parse(getKickoff(b) || "");
        return ta - tb;
      })
      .slice(0, MAX_LINEUPS);

    const lineups = [];

    for (const match of upcoming) {
      const id = getMatchId(match);

      if (!id) continue;

      const lineupPayload = await safeFetch(
        `/v1/stored/matches/${encodeURIComponent(id)}/lineups`,
        key,
        diagnostics,
        "lineups"
      );

      diagnostics.lineupsChecked++;

      if (lineupPayload) {
        const data = extractData(lineupPayload);

        lineups.push({
          matchId: id,
          homeTeam: getHomeTeam(match),
          awayTeam: getAwayTeam(match),
          kickoff: getKickoff(match),
          data,
        });
      }
    }

    // ---------------------------------------------------------
    // 6. DIRECT MATCH xG
    // ---------------------------------------------------------

    const directMatchXG = {};

    for (const row of historicalRows) {
      if (!row.xg) continue;

      directMatchXG[row.id] = {
        home: row.xg.home,
        away: row.xg.away,
      };
    }

    // ---------------------------------------------------------
    // 7. RESPONSE
    // ---------------------------------------------------------

    const response = {
      ok: true,
      source: "Big Balls Sports Data",
      league: LEAGUE,
      generatedAt: new Date().toISOString(),

      coverage: {
        matches: matches.length,
        historicalMatches: historicalMatches.length,
        historicalStatsChecked:
          diagnostics.historicalStatsChecked,
        xG: Object.keys(directMatchXG).length,
        directMatchXG: Object.keys(directMatchXG).length,
        teamsWithXG: Object.keys(teamXG).length,
        lineups: lineups.length,
        standings: standings.length,
      },

      matches,

      standings,

      teamXG,

      directMatchXG,

      lineups,

      diagnostics: {
        apiKeyDetected: true,
        errors: diagnostics.errors,
        xGSamples: diagnostics.xGSamples,
        requestBudgetEstimate:
          2 +
          (historicalCandidates.length || 0) +
          (upcoming.length || 0),
        durationMs: Date.now() - startedAt,
      },
    };

    return res.status(200).json(response);
  } catch (error) {
    // ---------------------------------------------------------
    // 429 — DO NOT RETRY AUTOMATICALLY
    // ---------------------------------------------------------

    if (error?.status === 429) {
      return res.status(429).json({
        ok: false,
        error: "Big Balls Data rate limit reached.",
        message:
          "Wait until Retry-After expires before calling /api/sync again.",

        retryAfter: error.retryAfter,

        diagnostics: {
          apiKeyDetected: true,
          status: 429,
          body: error.body || null,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    return res.status(500).json({
      ok: false,
      error: error?.message || "Unknown sync error",

      diagnostics: {
        apiKeyDetected: true,
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
