const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const SPORT = "football";
const LEAGUE = "seriea";

const MATCH_TIMEOUT = 8000;
const OPTIONAL_TIMEOUT = 6000;

const MAX_STATS_REQUESTS = 8;
const MAX_LINEUP_REQUESTS = 6;
const STORED_MATCHES_LIMIT = 200;

/**
 * Chiamata a Big Balls Data.
 */
async function fetchBBS(path, timeoutMs = OPTIONAL_TIMEOUT) {
  if (!API_KEY) {
    return {
      ok: false,
      status: 500,
      data: null,
      error: "BBS_API_KEY non configurata."
    };
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${BBS_BASE}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": API_KEY,
        Authorization: `Bearer ${API_KEY}`
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        timeout: true,
        data: null,
        error: "Timeout"
      };
    }

    return {
      ok: false,
      status: 500,
      data: null,
      error: error?.message || "Network error"
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Estrae un array da diverse strutture JSON.
 */
function extractArray(data, keys = []) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  for (const key of keys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (data.data && typeof data.data === "object") {
    for (const key of keys) {
      if (Array.isArray(data.data[key])) {
        return data.data[key];
      }
    }
  }

  return [];
}

/**
 * ID partita.
 */
function getMatchId(match) {
  if (!match || typeof match !== "object") {
    return null;
  }

  return (
    match.id ??
    match.match_id ??
    match.matchId ??
    match.fixture_id ??
    match.fixtureId ??
    null
  );
}

/**
 * Nome squadra.
 */
function getTeamName(team) {
  if (!team) {
    return "";
  }

  if (typeof team === "string") {
    return team;
  }

  return (
    team.name ??
    team.team_name ??
    team.short_name ??
    team.display_name ??
    ""
  );
}

/**
 * Conversione numerica sicura.
 */
function toNumber(value) {
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

/**
 * Ricerca ricorsiva degli xG.
 */
function extractXG(data) {
  if (!data) {
    return null;
  }

  function search(obj) {
    if (!obj || typeof obj !== "object") {
      return null;
    }

    /*
     * Caso:
     *
     * home: { xg: 1.45 }
     * away: { xg: 0.82 }
     */
    const homeObject =
      obj.home ??
      obj.home_team ??
      obj.homeTeam ??
      null;

    const awayObject =
      obj.away ??
      obj.away_team ??
      obj.awayTeam ??
      null;

    if (
      homeObject &&
      awayObject &&
      typeof homeObject === "object" &&
      typeof awayObject === "object"
    ) {
      const homeXG = toNumber(
        homeObject.xg ??
        homeObject.xG ??
        homeObject.expected_goals ??
        homeObject.expectedGoals
      );

      const awayXG = toNumber(
        awayObject.xg ??
        awayObject.xG ??
        awayObject.expected_goals ??
        awayObject.expectedGoals
      );

      if (
        homeXG !== null &&
        awayXG !== null &&
        homeXG >= 0 &&
        awayXG >= 0
      ) {
        return {
          homeXG,
          awayXG
        };
      }
    }

    /*
     * Caso:
     *
     * home_xg
     * away_xg
     * homeXG
     * awayXG
     */
    const homeCandidates = [
      obj.home_xg,
      obj.homeXG,
      obj.home_xG,
      obj.xg_home,
      obj.xG_home,
      obj.expected_goals_home,
      obj.expectedGoalsHome
    ];

    const awayCandidates = [
      obj.away_xg,
      obj.awayXG,
      obj.away_xG,
      obj.xg_away,
      obj.xG_away,
      obj.expected_goals_away,
      obj.expectedGoalsAway
    ];

    let homeXG = null;
    let awayXG = null;

    for (const value of homeCandidates) {
      const number = toNumber(value);

      if (
        number !== null &&
        number >= 0 &&
        number <= 15
      ) {
        homeXG = number;
        break;
      }
    }

    for (const value of awayCandidates) {
      const number = toNumber(value);

      if (
        number !== null &&
        number >= 0 &&
        number <= 15
      ) {
        awayXG = number;
        break;
      }
    }

    if (
      homeXG !== null &&
      awayXG !== null
    ) {
      return {
        homeXG,
        awayXG
      };
    }

    /*
     * Caso:
     *
     * xg: {
     *   home: 1.5,
     *   away: 0.8
     * }
     */
    const xgObject =
      obj.xg ??
      obj.xG ??
      obj.expected_goals ??
      obj.expectedGoals ??
      null;

    if (
      xgObject &&
      typeof xgObject === "object"
    ) {
      const home = toNumber(
        xgObject.home ??
        xgObject.home_xg ??
        xgObject.homeXG
      );

      const away = toNumber(
        xgObject.away ??
        xgObject.away_xg ??
        xgObject.awayXG
      );

      if (
        home !== null &&
        away !== null &&
        home >= 0 &&
        away >= 0
      ) {
        return {
          homeXG: home,
          awayXG: away
        };
      }
    }

    /*
     * Ricerca dentro contenitori.
     */
    const children = [
      "data",
      "stats",
      "statistics",
      "match_stats",
      "matchStats",
      "teams",
      "team_stats",
      "teamStats"
    ];

    for (const key of children) {
      const child = obj[key];

      if (Array.isArray(child)) {
        for (const item of child) {
          const result = search(item);

          if (result) {
            return result;
          }
        }
      } else if (
        child &&
        typeof child === "object"
      ) {
        const result = search(child);

        if (result) {
          return result;
        }
      }
    }

    return null;
  }

  return search(data);
}

/**
 * Match correnti.
 */
async function fetchCurrentMatches() {
  return fetchBBS(
    `/v1/matches?sport=${SPORT}&league=${LEAGUE}&limit=50`,
    MATCH_TIMEOUT
  );
}

/**
 * Storico FINITO.
 *
 * Qui usiamo esplicitamente:
 *
 * status=finished
 * limit=200
 *
 * BBD documenta entrambi i parametri.
 */
async function fetchFinishedMatches() {
  return fetchBBS(
    `/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}&status=finished&limit=${STORED_MATCHES_LIMIT}`,
    MATCH_TIMEOUT
  );
}

/**
 * Stats della partita.
 */
async function fetchMatchStats(matchId) {
  if (!matchId) {
    return {
      ok: false,
      status: 400,
      data: null,
      xG: null
    };
  }

  const result = await fetchBBS(
    `/v1/stored/matches/${encodeURIComponent(matchId)}/stats`,
    OPTIONAL_TIMEOUT
  );

  return {
    ...result,
    xG: result.ok
      ? extractXG(result.data)
      : null
  };
}

/**
 * Lineup.
 */
async function fetchMatchLineup(matchId) {
  if (!matchId) {
    return {
      ok: false,
      status: 400,
      data: null
    };
  }

  return fetchBBS(
    `/v1/stored/matches/${encodeURIComponent(matchId)}/lineups`,
    OPTIONAL_TIMEOUT
  );
}

/**
 * Handler principale.
 */
async function run(res) {
  const started = Date.now();

  const diagnostics = {
    apiKeyDetected: Boolean(API_KEY),

    requests: 0,

    matches: {
      status: null,
      elapsedMs: null
    },

    storedMatches: {
      status: null,
      elapsedMs: null,
      count: 0
    },

    standings: {
      status: null,
      elapsedMs: null
    },

    stats: {
      requested: 0,
      successful: 0,
      withXG: 0,
      errors: 0,
      rateLimited: false
    },

    lineups: {
      requested: 0,
      successful: 0,
      errors: 0,
      rateLimited: false
    }
  };

  /*
   * API KEY
   */
  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "BBS_API_KEY non configurata su Vercel.",
      diagnostics
    });
  }

  /*
   * ================================================
   * 1. MATCH FUTURI / CORRENTI
   * ================================================
   */

  const matchesStarted = Date.now();

  diagnostics.requests++;

  const matchesResult =
    await fetchCurrentMatches();

  diagnostics.matches.status =
    matchesResult.status;

  diagnostics.matches.elapsedMs =
    Date.now() - matchesStarted;

  if (!matchesResult.ok) {
    return res.status(
      matchesResult.timeout
        ? 504
        : matchesResult.status || 500
    ).json({
      ok: false,

      error:
        matchesResult.timeout
          ? "Big Balls Data non ha risposto entro 8 secondi."
          : `Errore Big Balls Data HTTP ${matchesResult.status}.`,

      body:
        matchesResult.data || null,

      diagnostics: {
        ...diagnostics,

        totalElapsedMs:
          Date.now() - started
      }
    });
  }

  const matches =
    extractArray(
      matchesResult.data,
      [
        "matches",
        "fixtures",
        "events"
      ]
    );

  /*
   * ================================================
   * 2. STORICO FINITO
   * ================================================
   */

  const storedStarted = Date.now();

  diagnostics.requests++;

  const storedResult =
    await fetchFinishedMatches();

  diagnostics.storedMatches.status =
    storedResult.status;

  diagnostics.storedMatches.elapsedMs =
    Date.now() - storedStarted;

  let storedMatches = [];

  if (storedResult.ok) {
    storedMatches =
      extractArray(
        storedResult.data,
        [
          "matches",
          "fixtures",
          "events"
        ]
      );
  }

  diagnostics.storedMatches.count =
    storedMatches.length;

  /*
   * ================================================
   * 3. STANDINGS
   * ================================================
   */

  let standings = [];

  const standingsStarted =
    Date.now();

  diagnostics.requests++;

  const standingsResult =
    await fetchBBS(
      `/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
      OPTIONAL_TIMEOUT
    );

  diagnostics.standings.status =
    standingsResult.status;

  diagnostics.standings.elapsedMs =
    Date.now() - standingsStarted;

  if (standingsResult.ok) {
    standings =
      extractArray(
        standingsResult.data,
        [
          "standings",
          "table",
          "rows"
        ]
      );
  }

  /*
   * ================================================
   * 4. XG STORICI
   * ================================================
   */

  const statsCandidates =
    storedMatches
      .filter(
        match =>
          Boolean(getMatchId(match))
      )
      .slice(
        0,
        MAX_STATS_REQUESTS
      );

  const matchXG = [];

  const teamAccumulator = {};

  for (const match of statsCandidates) {
    if (
      diagnostics.stats.requested >=
      MAX_STATS_REQUESTS
    ) {
      break;
    }

    const matchId =
      getMatchId(match);

    diagnostics.stats.requested++;
    diagnostics.requests++;

    const statsResult =
      await fetchMatchStats(matchId);

    /*
     * Se BBD restituisce 429,
     * smettiamo immediatamente.
     */
    if (!statsResult.ok) {
      diagnostics.stats.errors++;

      if (
        statsResult.status === 429
      ) {
        diagnostics.stats.rateLimited =
          true;

        break;
      }

      continue;
    }

    diagnostics.stats.successful++;

    /*
     * Nessun xG per questa partita.
     */
    if (!statsResult.xG) {
      continue;
    }

    diagnostics.stats.withXG++;

    const homeTeam =
      getTeamName(match.home) ||
      getTeamName(match.home_team) ||
      match.homeTeam ||
      "";

    const awayTeam =
      getTeamName(match.away) ||
      getTeamName(match.away_team) ||
      match.awayTeam ||
      "";

    const xg =
      statsResult.xG;

    /*
     * Salviamo xG della singola partita.
     */
    matchXG.push({
      matchId,

      homeTeam,

      awayTeam,

      homeXG:
        Number(
          xg.homeXG.toFixed(3)
        ),

      awayXG:
        Number(
          xg.awayXG.toFixed(3)
        ),

      source:
        "BBD stored match stats"
    });

    /*
     * ============================================
     * MEDIA XG SQUADRA
     * ============================================
     */

    const homeKey =
      homeTeam
        .trim()
        .toLowerCase();

    const awayKey =
      awayTeam
        .trim()
        .toLowerCase();

    if (homeKey) {
      if (!teamAccumulator[homeKey]) {
        teamAccumulator[homeKey] = {
          sum: 0,
          count: 0
        };
      }

      teamAccumulator[homeKey].sum +=
        xg.homeXG;

      teamAccumulator[homeKey].count++;
    }

    if (awayKey) {
      if (!teamAccumulator[awayKey]) {
        teamAccumulator[awayKey] = {
          sum: 0,
          count: 0
        };
      }

      teamAccumulator[awayKey].sum +=
        xg.awayXG;

      teamAccumulator[awayKey].count++;
    }
  }

  /*
   * Calcolo media xG per squadra.
   */
  const teamXG = {};

  for (
    const [team, value]
    of Object.entries(teamAccumulator)
  ) {
    if (value.count > 0) {
      teamXG[team] =
        Number(
          (
            value.sum /
            value.count
          ).toFixed(3)
        );
    }
  }

  /*
   * ================================================
   * 5. LINEUPS
   * ================================================
   */

  const lineupCandidates =
    matches
      .filter(
        match =>
          Boolean(
            getMatchId(match)
          )
      )
      .slice(
        0,
        MAX_LINEUP_REQUESTS
      );

  const lineups = [];

  for (const match of lineupCandidates) {
    if (
      diagnostics.lineups.requested >=
      MAX_LINEUP_REQUESTS
    ) {
      break;
    }

    const matchId =
      getMatchId(match);

    diagnostics.lineups.requested++;
    diagnostics.requests++;

    const lineupResult =
      await fetchMatchLineup(matchId);

    if (!lineupResult.ok) {
      diagnostics.lineups.errors++;

      if (
        lineupResult.status === 429
      ) {
        diagnostics.lineups.rateLimited =
          true;

        break;
      }

      continue;
    }

    diagnostics.lineups.successful++;

    lineups.push({
      matchId,
      data: lineupResult.data
    });
  }

  /*
   * ================================================
   * 6. COVERAGE
   * ================================================
   */

  const coverage = {
    matches:
      matches.length,

    storedFinishedMatches:
      storedMatches.length,

    xG:
      matchXG.length,

    teamsWithXG:
      Object.keys(teamXG).length,

    lineups:
      lineups.length,

    standings:
      standings.length
  };

  /*
   * ================================================
   * 7. RISPOSTA
   * ================================================
   */

  return res.status(200).json({
    ok: true,

    source:
      "Big Balls Sports Data",

    league:
      LEAGUE,

    generatedAt:
      new Date().toISOString(),

    coverage,

    matches,

    matchXG,

    teamXG,

    lineups,

    standings,

    diagnostics: {
      ...diagnostics,

      totalElapsedMs:
        Date.now() - started
    }
  });
}

/**
 * Vercel Serverless Function.
 */
export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  /*
   * CORS.
   */
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  /*
   * Solo GET.
   */
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Usa GET per /api/sync."
    });
  }

  try {
    return await run(res);
  } catch (error) {
    console.error(
      "SYNC FATAL:",
      error
    );

    return res.status(500).json({
      ok: false,

      error:
        "SYNC_FAILED",

      message:
        error?.message ||
        "Errore durante la sincronizzazione.",

      diagnostics: {
        apiKeyDetected:
          Boolean(API_KEY)
      }
    });
  }
}
