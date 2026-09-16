const BBS_BASE = "https://api.bigballsdata.com";

const SPORT = "football";
const LEAGUE = "seriea";

const TIMEOUT = 12000;

// Limiti volutamente bassi per il piano Free.
const MAX_HISTORICAL_MATCHES = 20;
const MAX_HISTORICAL_STATS = 8;
const MAX_LINEUPS = 6;

function getKey() {
  return process.env.BBS_API_KEY || "";
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -----------------------------------------------------------
   GENERIC HELPERS
----------------------------------------------------------- */

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.matches)) return payload.data.matches;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.results)) return payload.results;

  return [];
}

function extractData(payload) {
  if (payload?.data !== undefined) {
    return payload.data;
  }

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

function getTeamName(team) {
  if (!team) return null;

  if (typeof team === "string") {
    return team;
  }

  if (typeof team === "object") {
    return (
      team.name ||
      team.team_name ||
      team.teamName ||
      team.short_name ||
      team.shortName ||
      null
    );
  }

  return null;
}

function getHomeTeam(match) {
  return getTeamName(
    match?.home ||
      match?.home_team ||
      match?.homeTeam ||
      match?.teams?.home
  );
}

function getAwayTeam(match) {
  return getTeamName(
    match?.away ||
      match?.away_team ||
      match?.awayTeam ||
      match?.teams?.away
  );
}

function isFuture(match) {
  const kickoff = getKickoff(match);

  if (!kickoff) return false;

  const timestamp = Date.parse(kickoff);

  if (!Number.isFinite(timestamp)) return false;

  return timestamp > Date.now();
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

    if (
      home !== null &&
      home !== undefined &&
      away !== null &&
      away !== undefined
    ) {
      return true;
    }
  }

  return false;
}

/* -----------------------------------------------------------
   API REQUEST
----------------------------------------------------------- */

async function fetchJSON(path, key) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  try {
    const response = await fetch(`${BBS_BASE}${path}`, {
      method: "GET",

      headers: {
        Authorization: `Bearer ${key}`,
        "X-API-Key": key,
        Accept: "application/json",
      },

      signal: controller.signal,
    });

    const retryAfterHeader = response.headers.get("Retry-After");

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

      if (retryAfterHeader) {
        const parsedRetry = Number(retryAfterHeader);

        error.retryAfter = Number.isFinite(parsedRetry)
          ? parsedRetry
          : null;
      } else {
        error.retryAfter = null;
      }

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* -----------------------------------------------------------
   SAFE REQUEST
----------------------------------------------------------- */

async function safeFetch(path, key, diagnostics, label) {
  try {
    return await fetchJSON(path, key);
  } catch (error) {
    diagnostics.errors.push({
      label,
      path,
      status: error?.status || null,
      message: error?.message || String(error),
      retryAfter: error?.retryAfter ?? null,
    });

    return null;
  }
}

/* -----------------------------------------------------------
   xG PARSER
----------------------------------------------------------- */

function validXG(home, away) {
  const h = Number(home);
  const a = Number(away);

  if (
    !Number.isFinite(h) ||
    !Number.isFinite(a)
  ) {
    return null;
  }

  if (h < 0 || a < 0) {
    return null;
  }

  // Sanity check.
  if (h > 10 || a > 10) {
    return null;
  }

  return {
    home: h,
    away: a,
  };
}

function findNumber(object, possibleKeys) {
  if (!object || typeof object !== "object") {
    return null;
  }

  for (const key of possibleKeys) {
    if (object[key] !== undefined && object[key] !== null) {
      const value = Number(object[key]);

      if (Number.isFinite(value)) {
        return value;
      }
    }
  }

  return null;
}

function findXGValues(node, depth = 0) {
  if (
    node === null ||
    node === undefined ||
    depth > 15
  ) {
    return null;
  }

  /* ---------------------------------------------------------
     ARRAY
  --------------------------------------------------------- */

  if (Array.isArray(node)) {
    for (const item of node) {
      const result = findXGValues(
        item,
        depth + 1
      );

      if (result) {
        return result;
      }
    }

    return null;
  }

  /* ---------------------------------------------------------
     PRIMITIVE
  --------------------------------------------------------- */

  if (typeof node !== "object") {
    return null;
  }

  const keys = Object.keys(node);

  /* ---------------------------------------------------------
     CASE 1

     {
       home: {
         xg: 1.4
       },
       away: {
         xg: 0.8
       }
     }
  --------------------------------------------------------- */

  const homeObject =
    node.home ||
    node.home_team ||
    node.homeTeam ||
    node.home_side ||
    node.homeSide ||
    null;

  const awayObject =
    node.away ||
    node.away_team ||
    node.awayTeam ||
    node.away_side ||
    node.awaySide ||
    null;

  if (
    homeObject &&
    typeof homeObject === "object" &&
    awayObject &&
    typeof awayObject === "object"
  ) {
    const homeXG = findNumber(
      homeObject,
      [
        "xg",
        "XG",
        "expected_goals",
        "expectedGoals",
        "expected_xg",
        "expectedXG",
        "expected_goal",
        "expectedGoal",
      ]
    );

    const awayXG = findNumber(
      awayObject,
      [
        "xg",
        "XG",
        "expected_goals",
        "expectedGoals",
        "expected_xg",
        "expectedXG",
        "expected_goal",
        "expectedGoal",
      ]
    );

    const result = validXG(
      homeXG,
      awayXG
    );

    if (result) {
      return result;
    }
  }

  /* ---------------------------------------------------------
     CASE 2

     {
       home_xg: 1.4,
       away_xg: 0.8
     }
  --------------------------------------------------------- */

  const homeKey = keys.find((key) => {
    const normalized = key
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    return (
      normalized === "home_xg" ||
      normalized === "home_xg_value" ||
      normalized === "home_expected_goals" ||
      normalized === "home_expected_xg" ||
      normalized === "homexg"
    );
  });

  const awayKey = keys.find((key) => {
    const normalized = key
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    return (
      normalized === "away_xg" ||
      normalized === "away_xg_value" ||
      normalized === "away_expected_goals" ||
      normalized === "away_expected_xg" ||
      normalized === "awayxg"
    );
  });

  if (homeKey && awayKey) {
    const result = validXG(
      node[homeKey],
      node[awayKey]
    );

    if (result) {
      return result;
    }
  }

  /* ---------------------------------------------------------
     CASE 3

     {
       xg: {
         home: 1.4,
         away: 0.8
       }
     }
  --------------------------------------------------------- */

  for (const key of keys) {
    const normalized = key
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (
      normalized === "xg" ||
      normalized === "expected_goals" ||
      normalized === "expected_xg" ||
      normalized === "expectedgoals"
    ) {
      const value = node[key];

      if (
        value &&
        typeof value === "object"
      ) {
        const home = findNumber(
          value,
          [
            "home",
            "home_xg",
            "homeXG",
            "home_expected_goals",
            "homeExpectedGoals",
          ]
        );

        const away = findNumber(
          value,
          [
            "away",
            "away_xg",
            "awayXG",
            "away_expected_goals",
            "awayExpectedGoals",
          ]
        );

        const result = validXG(
          home,
          away
        );

        if (result) {
          return result;
        }
      }
    }
  }

  /* ---------------------------------------------------------
     CASE 4

     Arrays such as:

     [
       {
         team: "Roma",
         xg: 1.4
       },
       {
         team: "Inter",
         xg: 0.8
       }
     ]

     We don't know which side is home/away here,
     so don't use it as match xG automatically.
  --------------------------------------------------------- */

  /* ---------------------------------------------------------
     CASE 5
     RECURSIVE SEARCH
  --------------------------------------------------------- */

  for (const key of keys) {
    const result = findXGValues(
      node[key],
      depth + 1
    );

    if (result) {
      return result;
    }
  }

  return null;
}

/* -----------------------------------------------------------
   DIAGNOSTIC KEY SEARCH
----------------------------------------------------------- */

function collectInterestingKeys(
  node,
  output = new Set(),
  depth = 0
) {
  if (
    node === null ||
    node === undefined ||
    depth > 10
  ) {
    return output;
  }

  if (Array.isArray(node)) {
    for (
      const item of node.slice(0, 30)
    ) {
      collectInterestingKeys(
        item,
        output,
        depth + 1
      );
    }

    return output;
  }

  if (typeof node !== "object") {
    return output;
  }

  for (
    const [key, value] of Object.entries(node)
  ) {
    const normalized = key
      .toLowerCase();

    if (
      normalized.includes("xg") ||
      normalized.includes("expected") ||
      normalized.includes("goal") ||
      normalized.includes("stat")
    ) {
      output.add(key);
    }

    collectInterestingKeys(
      value,
      output,
      depth + 1
    );
  }

  return output;
}

/* -----------------------------------------------------------
   TEAM xG AGGREGATION
----------------------------------------------------------- */

function buildTeamXG(rows) {
  const buckets = {};

  function add(team, xg) {
    if (!team) return;

    const value = Number(xg);

    if (!Number.isFinite(value)) {
      return;
    }

    const normalized = normalizeText(team);

    if (!normalized) {
      return;
    }

    if (!buckets[normalized]) {
      buckets[normalized] = {
        name: team,
        values: [],
      };
    }

    buckets[normalized].values.push(value);
  }

  for (const row of rows) {
    if (!row.xg) continue;

    add(
      row.homeTeam,
      row.xg.home
    );

    add(
      row.awayTeam,
      row.xg.away
    );
  }

  const result = {};

  for (
    const bucket of Object.values(buckets)
  ) {
    if (!bucket.values.length) {
      continue;
    }

    const average =
      bucket.values.reduce(
        (sum, value) => sum + value,
        0
      ) /
      bucket.values.length;

    result[bucket.name] = {
      xGPerMatch:
        Number(average.toFixed(3)),

      samples:
        bucket.values.length,
    };
  }

  return result;
}

/* -----------------------------------------------------------
   MAIN HANDLER
----------------------------------------------------------- */

export default async function handler(
  req,
  res
) {
  const startedAt = Date.now();

  const key = getKey();

  /*
   * CDN cache.
   *
   * This also prevents repeated browser refreshes from
   * immediately hammering Big Balls Data.
   */
  res.setHeader(
    "Cache-Control",
    "s-maxage=300, stale-while-revalidate=600"
  );

  if (!key) {
    return res.status(500).json({
      ok: false,
      error:
        "Missing BBS_API_KEY environment variable",
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
    /* =======================================================
       1. CURRENT MATCHES
       1 API REQUEST
    ======================================================= */

    const matchesPayload =
      await fetchJSON(
        `/v1/matches?sport=${SPORT}&league=${LEAGUE}&limit=50`,
        key
      );

    const matches =
      extractArray(matchesPayload);

    /* =======================================================
       2. STANDINGS
       1 API REQUEST
    ======================================================= */

    const standingsPayload =
      await safeFetch(
        `/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
        key,
        diagnostics,
        "standings"
      );

    const standings =
      extractArray(standingsPayload);

    /* =======================================================
       3. HISTORICAL MATCHES
       1 API REQUEST
    ======================================================= */

    const historicalPayload =
      await safeFetch(
        `/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}&status=finished&limit=${MAX_HISTORICAL_MATCHES}`,
        key,
        diagnostics,
        "historical_matches"
      );

    const historicalMatches =
      extractArray(
        historicalPayload
      );

    /* =======================================================
       4. HISTORICAL STATS / xG

       MAX 8 REQUESTS
    ======================================================= */

    const historicalCandidates =
      historicalMatches
        .filter(isFinished)
        .slice(
          0,
          MAX_HISTORICAL_STATS
        );

    const historicalRows = [];

    for (
      const match of historicalCandidates
    ) {
      const matchId =
        getMatchId(match);

      if (!matchId) {
        continue;
      }

      const statsPayload =
        await safeFetch(
          `/v1/stored/matches/${encodeURIComponent(
            matchId
          )}/stats`,
          key,
          diagnostics,
          "historical_stats"
        );

      diagnostics.historicalStatsChecked++;

      if (!statsPayload) {
        continue;
      }

      const xg =
        findXGValues(
          statsPayload
        );

      const row = {
        id: matchId,

        homeTeam:
          getHomeTeam(match),

        awayTeam:
          getAwayTeam(match),

        kickoff:
          getKickoff(match),

        xg: xg || null,
      };

      historicalRows.push(row);

      /*
       * Only a tiny diagnostic object is returned.
       * We deliberately DON'T return the complete stats
       * payload.
       */


if (diagnostics.xGSamples.length < 1) {
  let sampleStats = null;

  try {
    sampleStats = JSON.stringify(statsPayload);
  } catch {
    sampleStats = null;
  }

  diagnostics.xGSamples.push({
    id: matchId,

    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,

    foundXG: Boolean(xg),
    parsedXG: xg || null,

    interestingKeys: Array.from(
      collectInterestingKeys(statsPayload)
    ).slice(0, 100),

    sampleStats: sampleStats
      ? sampleStats.slice(0, 8000)
      : null,
  });
}
      

    const directMatchXG = {};

    for (
      const row of historicalRows
    ) {
      if (!row.xg) continue;

      directMatchXG[row.id] = {
        home: row.xg.home,
        away: row.xg.away,
      };
    }

    const teamXG =
      buildTeamXG(
        historicalRows
      );

    /* =======================================================
       5. LINEUPS

       Only 6 upcoming matches.
    ======================================================= */

    const upcoming =
      matches
        .filter(isFuture)
        .sort((a, b) => {
          const ta =
            Date.parse(
              getKickoff(a) || ""
            );

          const tb =
            Date.parse(
              getKickoff(b) || ""
            );

          return ta - tb;
        })
        .slice(
          0,
          MAX_LINEUPS
        );

    const lineups = [];

    for (
      const match of upcoming
    ) {
      const matchId =
        getMatchId(match);

      if (!matchId) {
        continue;
      }

      const lineupPayload =
        await safeFetch(
          `/v1/stored/matches/${encodeURIComponent(
            matchId
          )}/lineups`,
          key,
          diagnostics,
          "lineups"
        );

      diagnostics.lineupsChecked++;

      if (!lineupPayload) {
        continue;
      }

      lineups.push({
        matchId,

        homeTeam:
          getHomeTeam(match),

        awayTeam:
          getAwayTeam(match),

        kickoff:
          getKickoff(match),

        data:
          extractData(
            lineupPayload
          ),
      });
    }

    /* =======================================================
       6. FINAL RESPONSE
    ======================================================= */

    const requestBudgetEstimate =
      1 + // matches
      1 + // standings
      1 + // historical matches
      historicalCandidates.length +
      upcoming.length;

    return res.status(200).json({
      ok: true,

      source:
        "Big Balls Sports Data",

      league:
        LEAGUE,

      generatedAt:
        new Date().toISOString(),

      coverage: {
        matches:
          matches.length,

        historicalMatches:
          historicalMatches.length,

        historicalStatsChecked:
          diagnostics.historicalStatsChecked,

        xG:
          Object.keys(
            directMatchXG
          ).length,

        directMatchXG:
          Object.keys(
            directMatchXG
          ).length,

        teamsWithXG:
          Object.keys(
            teamXG
          ).length,

        lineups:
          lineups.length,

        standings:
          standings.length,
      },

      matches,

      standings,

      teamXG,

      directMatchXG,

      lineups,

      diagnostics: {
        apiKeyDetected:
          true,

        requestBudgetEstimate,

        errors:
          diagnostics.errors,

        xGSamples:
          diagnostics.xGSamples,

        durationMs:
          Date.now() - startedAt,
      },
    });
  } catch (error) {
    /* =======================================================
       RATE LIMIT
    ======================================================= */

    if (error?.status === 429) {
      return res.status(429).json({
        ok: false,

        error:
          "Big Balls Data rate limit reached.",

        message:
          "Wait for the Retry-After period before calling /api/sync again.",

        retryAfter:
          error.retryAfter ?? null,

        diagnostics: {
          apiKeyDetected:
            true,

          status: 429,

          body:
            error.body || null,

          durationMs:
            Date.now() - startedAt,
        },
      });
    }

    /* =======================================================
       OTHER API ERRORS
    ======================================================= */

    return res.status(500).json({
      ok: false,

      error:
        error?.message ||
        "Unknown sync error",

      diagnostics: {
        apiKeyDetected:
          true,

        status:
          error?.status || null,

        body:
          error?.body || null,

        durationMs:
          Date.now() - startedAt,
      },
    });
  }
}
