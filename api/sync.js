const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "serie-a";
const SPORT = "football";

const TIMEOUT = 10000;

// Numero massimo di partite storiche da scaricare
const HISTORICAL_MATCH_LIMIT = 100;

// Numero massimo di partite storiche per cui chiedere gli xG.
// Manteniamo il consumo API sotto controllo.
const HISTORICAL_DETAIL_LIMIT = 20;

// Numero massimo di partite future per cui proviamo lineups/stats.
const FUTURE_DETAIL_LIMIT = 20;

function getApiKey() {
  return process.env.BBS_API_KEY || "";
}

async function bbsFetch(path) {
  const key = getApiKey();

  if (!key) {
    throw new Error("BBS_API_KEY non configurata su Vercel");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

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

    const text = await response.text();

    let body;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const error = new Error(
        `BBS ${response.status}: ${
          typeof body === "string"
            ? body.slice(0, 500)
            : JSON.stringify(body).slice(0, 500)
        }`
      );

      error.status = response.status;
      error.body = body;

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function arrayFrom(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.matches)) {
    return payload.matches;
  }

  if (Array.isArray(payload?.results)) {
    return payload.results;
  }

  return [];
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = toNumber(value);

    if (number !== null) {
      return number;
    }
  }

  return null;
}

function teamName(team) {
  if (!team) return null;

  if (typeof team === "string") {
    return team;
  }

  return (
    team.name ||
    team.short_name ||
    team.shortName ||
    team.display_name ||
    team.displayName ||
    null
  );
}

function normalizeMatch(match) {
  if (!match) return null;

  const home =
    teamName(match.home) ||
    match.homeTeam ||
    match.home_team ||
    match.home_name ||
    null;

  const away =
    teamName(match.away) ||
    match.awayTeam ||
    match.away_team ||
    match.away_name ||
    null;

  const score = match.score || match.scores || match.result || null;

  const homeScore = firstNumber(
    score?.home,
    score?.home_score,
    score?.homeScore,
    match.homeScore,
    match.home_score
  );

  const awayScore = firstNumber(
    score?.away,
    score?.away_score,
    score?.awayScore,
    match.awayScore,
    match.away_score
  );

  return {
    id: match.id || match.match_id || null,

    homeTeam: home,

    awayTeam: away,

    kickoff:
      match.kickoff_utc ||
      match.kickoffUtc ||
      match.kickoff ||
      match.start_time ||
      match.startTime ||
      null,

    status: match.status || null,

    matchday:
      match.matchday ||
      match.match_day ||
      match.round ||
      null,

    homeScore,

    awayScore,

    raw: match,
  };
}

function isCompletedMatch(match) {
  if (!match) return false;

  const status = String(match.status || "").toLowerCase();

  const completedStatuses = [
    "finished",
    "completed",
    "final",
    "ft",
    "ended",
    "post",
    "closed",
  ];

  if (completedStatuses.some((value) => status.includes(value))) {
    return true;
  }

  return (
    match.homeScore !== null &&
    match.awayScore !== null
  );
}

/**
 * Cerca xG in diversi formati possibili.
 *
 * Big Balls Data documenta il campo xG come match stat.
 * Manteniamo comunque il parser tollerante per eventuali
 * variazioni dell'envelope.
 */
function extractTeamXG(statsPayload, homeTeam, awayTeam) {
  if (!statsPayload) return null;

  const candidates = [];

  function collect(value, depth = 0) {
    if (value === null || value === undefined || depth > 6) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item, depth + 1);
      }

      return;
    }

    if (typeof value !== "object") {
      return;
    }

    candidates.push(value);

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        collect(child, depth + 1);
      }
    }
  }

  collect(statsPayload);

  let homeXG = null;
  let awayXG = null;

  for (const obj of candidates) {
    const objHome =
      obj.home ||
      obj.homeTeam ||
      obj.home_team ||
      obj.homeStats ||
      obj.home_stats;

    const objAway =
      obj.away ||
      obj.awayTeam ||
      obj.away_team ||
      obj.awayStats ||
      obj.away_stats;

    if (objHome && typeof objHome === "object") {
      homeXG = firstNumber(
        homeXG,
        objHome.xg,
        objHome.xG,
        objHome.expected_goals,
        objHome.expectedGoals,
        objHome.expected_goals_for,
        objHome.expectedGoalsFor
      );
    }

    if (objAway && typeof objAway === "object") {
      awayXG = firstNumber(
        awayXG,
        objAway.xg,
        objAway.xG,
        objAway.expected_goals,
        objAway.expectedGoals,
        objAway.expected_goals_for,
        objAway.expectedGoalsFor
      );
    }

    homeXG = firstNumber(
      homeXG,
      obj.home_xg,
      obj.homeXG,
      obj.home_expected_goals,
      obj.homeExpectedGoals,
      obj.xg_home,
      obj.xGHome
    );

    awayXG = firstNumber(
      awayXG,
      obj.away_xg,
      obj.awayXG,
      obj.away_expected_goals,
      obj.awayExpectedGoals,
      obj.xg_away,
      obj.xGAway
    );
  }

  /**
   * Alcuni envelope possono esporre direttamente:
   * {
   *   home: { xg: ... },
   *   away: { xg: ... }
   * }
   */
  if (
    homeXG === null &&
    awayXG === null &&
    statsPayload.data &&
    typeof statsPayload.data === "object" &&
    !Array.isArray(statsPayload.data)
  ) {
    const data = statsPayload.data;

    homeXG = firstNumber(
      data.home?.xg,
      data.home?.xG,
      data.home_xg,
      data.homeXG
    );

    awayXG = firstNumber(
      data.away?.xg,
      data.away?.xG,
      data.away_xg,
      data.awayXG
    );
  }

  if (homeXG === null && awayXG === null) {
    return null;
  }

  return {
    homeTeam,
    awayTeam,
    homeXG,
    awayXG,
  };
}

function addTeamXG(teamXG, team, xgFor, xgAgainst) {
  if (!team) return;

  const cleanFor = toNumber(xgFor);
  const cleanAgainst = toNumber(xgAgainst);

  if (cleanFor === null && cleanAgainst === null) {
    return;
  }

  if (!teamXG[team]) {
    teamXG[team] = {
      matches: 0,
      xgFor: 0,
      xgAgainst: 0,
      samples: 0,
    };
  }

  const row = teamXG[team];

  row.matches += 1;

  if (cleanFor !== null) {
    row.xgFor += cleanFor;
  }

  if (cleanAgainst !== null) {
    row.xgAgainst += cleanAgainst;
  }

  row.samples += 1;
}

function finalizeTeamXG(teamXG) {
  const result = {};

  for (const [team, row] of Object.entries(teamXG)) {
    if (!row.samples) continue;

    result[team] = {
      matches: row.matches,

      xgFor: Number(
        (row.xgFor / row.samples).toFixed(3)
      ),

      xgAgainst: Number(
        (row.xgAgainst / row.samples).toFixed(3)
      ),
    };
  }

  return result;
}

function normalizeLineups(payload) {
  if (!payload) return null;

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.lineups)) {
    return payload.lineups;
  }

  if (payload.data?.lineups && Array.isArray(payload.data.lineups)) {
    return payload.data.lineups;
  }

  return null;
}

function formatError(error) {
  return {
    status: error?.status || null,
    message: error?.message || String(error),
    body:
      typeof error?.body === "string"
        ? error.body.slice(0, 1000)
        : error?.body || null,
  };
}

async function getFutureDetails(matches) {
  const candidates = matches
    .filter((match) => match?.id)
    .slice(0, FUTURE_DETAIL_LIMIT);

  const details = [];

  for (const match of candidates) {
    const detail = {
      id: match.id,
      xG: null,
      lineups: null,
      errors: [],
    };

    // Stats
    try {
      const stats = await bbsFetch(
        `/v1/stored/matches/${encodeURIComponent(
          match.id
        )}/stats`
      );

      const xg = extractTeamXG(
        stats,
        match.homeTeam,
        match.awayTeam
      );

      if (xg) {
        detail.xG = xg;
      }
    } catch (error) {
      detail.errors.push({
        type: "stats",
        ...formatError(error),
      });
    }

    // Lineups
    try {
      const lineups = await bbsFetch(
        `/v1/stored/matches/${encodeURIComponent(
          match.id
        )}/lineups`
      );

      detail.lineups = normalizeLineups(lineups);
    } catch (error) {
      detail.errors.push({
        type: "lineups",
        ...formatError(error),
      });
    }

    details.push(detail);
  }

  return details;
}

async function getHistoricalXG() {
  const diagnostics = [];

  let historicalPayload;

  try {
    historicalPayload = await bbsFetch(
      `/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}&limit=${HISTORICAL_MATCH_LIMIT}`
    );
  } catch (error) {
    diagnostics.push({
      type: "historical_matches",
      ...formatError(error),
    });

    return {
      teamXG: {},
      historicalMatches: [],
      xGCount: 0,
      diagnostics,
    };
  }

  const historicalMatches = arrayFrom(historicalPayload)
    .map(normalizeMatch)
    .filter(Boolean)
    .filter(isCompletedMatch);

  /**
   * Ordiniamo dalla partita più recente alla più vecchia.
   */
  historicalMatches.sort((a, b) => {
    const dateA = a.kickoff
      ? new Date(a.kickoff).getTime()
      : 0;

    const dateB = b.kickoff
      ? new Date(b.kickoff).getTime()
      : 0;

    return dateB - dateA;
  });

  const selected = historicalMatches.slice(
    0,
    HISTORICAL_DETAIL_LIMIT
  );

  const teamAccumulator = {};
  let xGCount = 0;

  for (const match of selected) {
    if (!match.id) continue;

    try {
      const stats = await bbsFetch(
        `/v1/stored/matches/${encodeURIComponent(
          match.id
        )}/stats`
      );

      const xg = extractTeamXG(
        stats,
        match.homeTeam,
        match.awayTeam
      );

      if (!xg) {
        diagnostics.push({
          type: "historical_stats",
          matchId: match.id,
          message: "Stats returned but xG fields were not found",
        });

        continue;
      }

      if (
        xg.homeXG === null &&
        xg.awayXG === null
      ) {
        continue;
      }

      addTeamXG(
        teamAccumulator,
        match.homeTeam,
        xg.homeXG,
        xg.awayXG
      );

      addTeamXG(
        teamAccumulator,
        match.awayTeam,
        xg.awayXG,
        xg.homeXG
      );

      xGCount += 1;
    } catch (error) {
      diagnostics.push({
        type: "historical_stats",
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        ...formatError(error),
      });
    }
  }

  return {
    teamXG: finalizeTeamXG(teamAccumulator),
    historicalMatches: selected,
    xGCount,
    diagnostics,
  };
}

async function getStandings() {
  try {
    const payload = await bbsFetch(
      `/v1/standings?sport=${SPORT}&league=${LEAGUE}`
    );

    return {
      standings: arrayFrom(payload),
      error: null,
    };
  } catch (error) {
    return {
      standings: [],
      error: formatError(error),
    };
  }
}

async function getCurrentMatches() {
  const payload = await bbsFetch(
    `/v1/matches?sport=${SPORT}&league=${LEAGUE}`
  );

  return arrayFrom(payload)
    .map(normalizeMatch)
    .filter(Boolean);
}

function enrichMatches(matches, details) {
  const detailMap = new Map();

  for (const detail of details) {
    detailMap.set(detail.id, detail);
  }

  return matches.map((match) => {
    const detail = detailMap.get(match.id);

    if (!detail) {
      return {
        ...match,
        xG: null,
        lineups: null,
        detailErrors: [],
      };
    }

    return {
      ...match,

      xG: detail.xG
        ? {
            home: detail.xG.homeXG,
            away: detail.xG.awayXG,
          }
        : null,

      lineups: detail.lineups,

      detailErrors: detail.errors || [],
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const generatedAt = new Date().toISOString();

  try {
    if (!getApiKey()) {
      return res.status(500).json({
        ok: false,
        error: "BBS_API_KEY non configurata",
      });
    }

    /**
     * 1. Partite correnti / future
     */
    const matches = await getCurrentMatches();

    /**
     * 2. Dettagli delle partite correnti.
     * Non ci aspettiamo necessariamente xG per partite future.
     */
    const futureDetails = await getFutureDetails(matches);

    /**
     * 3. Storico + xG delle partite concluse.
     */
    const historical = await getHistoricalXG();

    /**
     * 4. Classifica.
     */
    const standingsResult = await getStandings();

    /**
     * 5. Uniamo i dettagli alle partite correnti.
     */
    const enrichedMatches = enrichMatches(
      matches,
      futureDetails
    );

    /**
     * xG disponibili direttamente sulle partite correnti.
     */
    const directXGCount = enrichedMatches.filter(
      (match) =>
        match.xG &&
        match.xG.home !== null &&
        match.xG.away !== null
    ).length;

    /**
     * Lineups disponibili.
     */
    const lineupCount = enrichedMatches.filter(
      (match) =>
        Array.isArray(match.lineups) &&
        match.lineups.length > 0
    ).length;

    /**
     * Errori dei dettagli delle partite correnti.
     */
    const detailErrors = futureDetails
      .filter(
        (detail) =>
          Array.isArray(detail.errors) &&
          detail.errors.length > 0
      )
      .map((detail) => ({
        matchId: detail.id,
        errors: detail.errors,
      }));

    return res.status(200).json({
      ok: true,

      source: "Big Balls Sports Data",

      league: LEAGUE,

      generatedAt,

      coverage: {
        matches: enrichedMatches.length,

        detailsAttempted: futureDetails.length,

        /**
         * Questo conta gli xG storici recuperati.
         * È il numero che interessa al predictor.
         */
        xG: historical.xGCount,

        /**
         * xG presenti direttamente sulle partite future.
         */
        directMatchXG: directXGCount,

        lineups: lineupCount,

        standings: standingsResult.standings.length,

        historicalMatches:
          historical.historicalMatches.length,

        teamsWithXG:
          Object.keys(historical.teamXG).length,
      },

      /**
       * Media xG storica per squadra.
       *
       * Esempio:
       * {
       *   "Inter Milan": {
       *     matches: 5,
       *     xgFor: 1.92,
       *     xgAgainst: 0.81
       *   }
       * }
       */
      teamXG: historical.teamXG,

      diagnostics: {
        apiKeyDetected: true,

        standingsAvailable:
          standingsResult.standings.length > 0,

        standingsError:
          standingsResult.error,

        detailErrors,

        historicalErrors:
          historical.diagnostics,
      },

      matches: enrichedMatches,

      standings: standingsResult.standings,
    });
  } catch (error) {
    console.error("SYNC ERROR", error);

    return res.status(500).json({
      ok: false,

      error:
        error?.message ||
        "Errore durante sincronizzazione BBS",

      generatedAt,

      diagnostics: {
        apiKeyDetected: Boolean(getApiKey()),

        status: error?.status || null,

        body:
          typeof error?.body === "string"
            ? error.body.slice(0, 1000)
            : error?.body || null,
      },
    });
  }
}
