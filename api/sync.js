const BBS_BASE = "https://api.bigballsdata.com";

const SPORT = "football";
const LEAGUE = "seriea";

const TIMEOUT = 12000;

// Limiti sicuri per il piano Free.
const MAX_HISTORICAL_MATCHES = 20;
const MAX_HISTORICAL_STATS = 8;
const MAX_LINEUPS = 6;

/* =========================================================
   BASIC HELPERS
========================================================= */

function getKey() {
  return process.env.BBS_API_KEY || "";
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.matches)) {
    return payload.data.matches;
  }
  if (Array.isArray(payload?.matches)) {
    return payload.matches;
  }
  if (Array.isArray(payload?.results)) {
    return payload.results;
  }

  return [];
}

function extractData(payload) {
  return payload?.data !== undefined
    ? payload.data
    : payload;
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

  const time = Date.parse(kickoff);

  if (!Number.isFinite(time)) return false;

  return time > Date.now();
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

/* =========================================================
   BBS REQUEST
========================================================= */

async function fetchJSON(path, key) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  try {
    const response = await fetch(
      `${BBS_BASE}${path}`,
      {
        method: "GET",

        headers: {
          Authorization: `Bearer ${key}`,
          "X-API-Key": key,
          Accept: "application/json",
        },

        signal: controller.signal,
      }
    );

    const retryAfter =
      response.headers.get("Retry-After");

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
    clearTimeout(timeout);
  }
}

async function safeFetch(
  path,
  key,
  diagnostics,
  label
) {
  try {
    return await fetchJSON(path, key);
  } catch (error) {
    diagnostics.errors.push({
      label,
      path,
      status: error?.status || null,
      message:
        error?.message || String(error),
      retryAfter:
        error?.retryAfter ?? null,
    });

    return null;
  }
}

/* =========================================================
   xG PARSER
========================================================= */

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function validXG(home, away) {
  const h = numberOrNull(home);
  const a = numberOrNull(away);

  if (h === null || a === null) {
    return null;
  }

  if (h < 0 || a < 0) {
    return null;
  }

  if (h > 10 || a > 10) {
    return null;
  }

  return {
    home: h,
    away: a,
  };
}

function getValue(object, keys) {
  if (
    !object ||
    typeof object !== "object"
  ) {
    return null;
  }

  for (const key of keys) {
    if (
      object[key] !== undefined &&
      object[key] !== null
    ) {
      return object[key];
    }
  }

  return null;
}

function tryHomeAwayObject(node) {
  if (
    !node ||
    typeof node !== "object"
  ) {
    return null;
  }

  const home =
    node.home ||
    node.home_team ||
    node.homeTeam ||
    node.home_side ||
    node.homeSide;

  const away =
    node.away ||
    node.away_team ||
    node.awayTeam ||
    node.away_side ||
    node.awaySide;

  if (
    !home ||
    !away ||
    typeof home !== "object" ||
    typeof away !== "object"
  ) {
    return null;
  }

  const homeXG = getValue(
    home,
    [
      "xg",
      "XG",
      "xG",
      "expected_goals",
      "expectedGoals",
      "expected_xg",
      "expectedXG",
      "expected_goal",
      "expectedGoal",
    ]
  );

  const awayXG = getValue(
    away,
    [
      "xg",
      "XG",
      "xG",
      "expected_goals",
      "expectedGoals",
      "expected_xg",
      "expectedXG",
      "expected_goal",
      "expectedGoal",
    ]
  );

  return validXG(
    homeXG,
    awayXG
  );
}

function tryDirectFields(node) {
  if (
    !node ||
    typeof node !== "object"
  ) {
    return null;
  }

  const keys = Object.keys(node);

  let homeKey = null;
  let awayKey = null;

  for (const key of keys) {
    const normalized = key
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (
      [
        "home_xg",
        "homexg",
        "home_expected_goals",
        "home_expected_xg",
      ].includes(normalized)
    ) {
      homeKey = key;
    }

    if (
      [
        "away_xg",
        "awayxg",
        "away_expected_goals",
        "away_expected_xg",
      ].includes(normalized)
    ) {
      awayKey = key;
    }
  }

  if (!homeKey || !awayKey) {
    return null;
  }

  return validXG(
    node[homeKey],
    node[awayKey]
  );
}

function tryNestedXG(node) {
  if (
    !node ||
    typeof node !== "object"
  ) {
    return null;
  }

  const keys = Object.keys(node);

  for (const key of keys) {
    const normalized = key
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (
      normalized === "xg" ||
      normalized === "expected_xg" ||
      normalized === "expected_goals" ||
      normalized === "expectedgoals"
    ) {
      const value = node[key];

      if (
        value &&
        typeof value === "object"
      ) {
        const home = getValue(
          value,
          [
            "home",
            "home_xg",
            "homeXG",
            "home_expected_goals",
            "homeExpectedGoals",
          ]
        );

        const away = getValue(
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

  return null;
}

function findXGValues(
  node,
  depth = 0
) {
  if (
    node === null ||
    node === undefined ||
    depth > 15
  ) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const result =
        findXGValues(
          item,
          depth + 1
        );

      if (result) {
        return result;
      }
    }

    return null;
  }

  if (typeof node !== "object") {
    return null;
  }

  // 1. home/away objects
  let result =
    tryHomeAwayObject(node);

  if (result) {
    return result;
  }

  // 2. home_xg / away_xg
  result =
    tryDirectFields(node);

  if (result) {
    return result;
  }

  // 3. xg: { home, away }
  result =
    tryNestedXG(node);

  if (result) {
    return result;
  }

  // 4. Recursive search
  for (const key of Object.keys(node)) {
    result =
      findXGValues(
        node[key],
        depth + 1
      );

    if (result) {
      return result;
    }
  }

  return null;
}

/* =========================================================
   DIAGNOSTIC STRUCTURE
========================================================= */

function collectInterestingKeys(
  node,
  output = new Set(),
  depth = 0
) {
  if (
    node === null ||
    node === undefined ||
    depth > 12
  ) {
    return output;
  }

  if (Array.isArray(node)) {
    for (
      const item of node.slice(0, 50)
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
    const normalized =
      key.toLowerCase();

    if (
      normalized.includes("xg") ||
      normalized.includes("expected") ||
      normalized.includes("goal") ||
      normalized.includes("stat") ||
      normalized.includes("metric")
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

/* =========================================================
   SAFE SAMPLE OF STATS RESPONSE

   We return only the first 8 KB for debugging.
========================================================= */

function makeSample(payload) {
  try {
    const text =
      JSON.stringify(payload);

    if (!text) {
      return null;
    }

    return text.slice(0, 8000);
  } catch {
    return null;
  }
}

/* =========================================================
   TEAM xG
========================================================= */

function buildTeamXG(rows) {
  const teams = {};

  function add(
    team,
    value
  ) {
    if (!team) return;

    const xg =
      numberOrNull(value);

    if (xg === null) {
      return;
    }

    const normalized =
      normalizeText(team);

    if (!normalized) {
      return;
    }

    if (!teams[normalized]) {
      teams[normalized] = {
        name: team,
        values: [],
      };
    }

    teams[normalized].values.push(xg);
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
    const team of Object.values(teams)
  ) {
    if (!team.values.length) {
      continue;
    }

    const average =
      team.values.reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
      team.values.length;

    result[team.name] = {
      xGPerMatch:
        Number(
          average.toFixed(3)
        ),

      samples:
        team.values.length,
    };
  }

  return result;
}

/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  const startedAt =
    Date.now();

  const key =
    getKey();

  /*
   * Vercel cache:
   * evita che refresh multipli chiamino subito BBS.
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
       1. MATCHES
       1 request
    ======================================================= */

    const matchesPayload =
      await fetchJSON(
        `/v1/matches?sport=${SPORT}&league=${LEAGUE}&limit=50`,
        key
      );

    const matches =
      extractArray(
        matchesPayload
      );

    /* =======================================================
       2. STANDINGS
       1 request
    ======================================================= */

    const standingsPayload =
      await safeFetch(
        `/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
        key,
        diagnostics,
        "standings"
      );

    const standings =
      extractArray(
        standingsPayload
      );

    /* =======================================================
       3. HISTORICAL MATCHES
       1 request
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
       4. HISTORICAL STATS
       max 8 requests
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

        xg:
          xg || null,
      };

      historicalRows.push(
        row
      );

      /*
       * DIAGNOSTICA:
       * prendiamo una sola risposta stats.
       */
      if (
        diagnostics.xGSamples.length === 0
      ) {
        diagnostics.xGSamples.push({
          id: matchId,

          homeTeam:
            row.homeTeam,

          awayTeam:
            row.awayTeam,

          foundXG:
            Boolean(xg),

          parsedXG:
            xg || null,

          interestingKeys:
            Array.from(
              collectInterestingKeys(
                statsPayload
              )
            ).slice(0, 100),

          sampleStats:
            makeSample(
              statsPayload
            ),
        });
      }
    }

    /* =======================================================
       5. DIRECT MATCH xG
    ======================================================= */

    const directMatchXG = {};

    for (
      const row of historicalRows
    ) {
      if (!row.xg) {
        continue;
      }

      directMatchXG[
        row.id
      ] = {
        home:
          row.xg.home,

        away:
          row.xg.away,
      };
    }

    /* =======================================================
       6. TEAM xG
    ======================================================= */

    const teamXG =
      buildTeamXG(
        historicalRows
      );

    /* =======================================================
       7. LINEUPS
       max 6 requests
    ======================================================= */

    const upcoming =
      matches
        .filter(isFuture)
        .sort(
          (a, b) => {
            const ta =
              Date.parse(
                getKickoff(a) || ""
              );

            const tb =
              Date.parse(
                getKickoff(b) || ""
              );

            return ta - tb;
          }
        )
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
       8. RESPONSE
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
       429
    ======================================================= */

    if (
      error?.status === 429
    ) {
      return res.status(429).json({
        ok: false,

        error:
          "Big Balls Data rate limit reached.",

        message:
          "Wait for Retry-After before calling /api/sync again.",

        retryAfter:
          error.retryAfter ??
          null,

        diagnostics: {
          apiKeyDetected:
            true,

          status: 429,

          body:
            error.body ||
            null,

          durationMs:
            Date.now() -
            startedAt,
        },
      });
    }

    /* =======================================================
       OTHER ERROR
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
          error?.status ||
          null,

        body:
          error?.body ||
          null,

        durationMs:
          Date.now() -
          startedAt,
      },
    });
  }
}
