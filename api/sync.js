const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "serie-a";
const SPORT = "football";

const TIMEOUT = 10000;

const HISTORICAL_MATCH_LIMIT = 100;
const HISTORICAL_DETAIL_LIMIT = 20;
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
    score?.value?.home,
    match.homeScore,
    match.home_score
  );

  const awayScore = firstNumber(
    score?.away,
    score?.away_score,
    score?.awayScore,
    score?.value?.away,
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
 * Normalizza una stringa per poter riconoscere
 * nomi come "xG", "xg", "expected_goals", ecc.
 */
function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Cerca ricorsivamente tutti i campi xG.
 *
 * Questa funzione è volutamente molto permissiva perché
 * l'endpoint BBS può contenere gli xG dentro diversi
 * livelli dell'oggetto stats.
 */
function findXGValues(payload) {
  const found = [];

  function walk(value, path = [], depth = 0) {
    if (value === null || value === undefined) {
      return;
    }

    if (depth > 10) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, [...path, index], depth + 1);
      });

      return;
    }

    if (typeof value !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeKey(key);

      if (
        normalized === "xg" ||
        normalized === "expectedgoals" ||
        normalized === "expectedgoalsfor" ||
        normalized === "expectedgoalsagainst"
      ) {
        const number = toNumber(child);

        if (number !== null) {
          found.push({
            key,
            value: number,
            path: [...path, key],
          });
        }
      }

      walk(child, [...path, key], depth + 1);
    }
  }

  walk(payload);

  return found;
}

/**
 * Cerca di capire a quale squadra appartiene ogni xG.
 *
 * Gestisce:
 *   home / away
 *   home_team / away_team
 *   team.name
 *   name
 *   label
 *   side
 */
function extractTeamXG(statsPayload, homeTeam, awayTeam) {
  if (!statsPayload) {
    return null;
  }

  const direct = findXGValues(statsPayload);

  if (!direct.length) {
    return null;
  }

  let homeXG = null;
  let awayXG = null;

  /**
   * Prima cerchiamo gli oggetti che contengono direttamente
   * un xG e informazioni sulla squadra/lato.
   */
  function scan(value, context = {}) {
    if (
      value === null ||
      value === undefined ||
      typeof value !== "object"
    ) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        scan(item, context);
      }

      return;
    }

    const localContext = {
      ...context,
      ...value,
    };

    const localHome =
      localContext.home ||
      localContext.home_team ||
      localContext.homeTeam;

    const localAway =
      localContext.away ||
      localContext.away_team ||
      localContext.awayTeam;

    const localTeam =
      localContext.team ||
      localContext.team_name ||
      localContext.teamName ||
      localContext.name;

    const side = String(
      localContext.side ||
      localContext.location ||
      localContext.homeAway ||
      ""
    ).toLowerCase();

    const xg = firstNumber(
      localContext.xg,
      localContext.xG,
      localContext.expected_goals,
      localContext.expectedGoals,
      localContext.expected_goals_for,
      localContext.expectedGoalsFor
    );

    if (xg !== null) {
      const teamText = String(localTeam || "").toLowerCase();

      if (
        side === "home" ||
        side === "h" ||
        teamText === String(homeTeam || "").toLowerCase() ||
        teamText.includes(String(homeTeam || "").toLowerCase())
      ) {
        homeXG = xg;
      }

      if (
        side === "away" ||
        side === "a" ||
        teamText === String(awayTeam || "").toLowerCase() ||
        teamText.includes(String(awayTeam || "").toLowerCase())
      ) {
        awayXG = xg;
      }
    }

    /**
     * Caso classico:
     *
     * {
     *   home: { xg: 1.5 },
     *   away: { xg: 0.8 }
     * }
     */
    if (localHome && typeof localHome === "object") {
      const value = firstNumber(
        localHome.xg,
        localHome.xG,
        localHome.expected_goals,
        localHome.expectedGoals
      );

      if (value !== null) {
        homeXG = value;
      }
    }

    if (localAway && typeof localAway === "object") {
      const value = firstNumber(
        localAway.xg,
        localAway.xG,
        localAway.expected_goals,
        localAway.expectedGoals
      );

      if (value !== null) {
        awayXG = value;
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        scan(child, localContext);
      }
    }
  }

  scan(statsPayload);

  /**
   * Se abbiamo trovato esattamente due xG ma non siamo riusciti
   * ad associarli alle squadre, assumiamo l'ordine home/away.
   *
   * Questo è utile per risposte del tipo:
   * [
   *   { xg: 1.72 },
   *   { xg: 0.84 }
   * ]
   */
  if (
    homeXG === null &&
    awayXG === null &&
    direct.length >= 2
  ) {
    homeXG = direct[0].value;
    awayXG = direct[1].value;
  }

  if (
    homeXG === null &&
    awayXG === null
  ) {
    return null;
  }

  return {
    homeTeam,
    awayTeam,
    homeXG,
    awayXG,
  };
}

function addTeamXG(
  teamXG,
  team,
  xgFor,
  xgAgainst
) {
  if (!team) return;

  const cleanFor = toNumber(xgFor);
  const cleanAgainst = toNumber(xgAgainst);

  if (
    cleanFor === null &&
    cleanAgainst === null
  ) {
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

  if (
    payload.data?.lineups &&
    Array.isArray(payload.data.lineups)
  ) {
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

    try {
      const lineups = await bbsFetch(
        `/v1/stored/matches/${encodeURIComponent(
          match.id
        )}/lineups`
      );

      detail.lineups =
        normalizeLineups(lineups);
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

  const historicalMatches = arrayFrom(
    historicalPayload
  )
    .map(normalizeMatch)
    .filter(Boolean)
    .filter(isCompletedMatch);

  historicalMatches.sort((a, b) => {
    const dateA = a.kickoff
      ? new Date(a.kickoff).getTime()
      : 0;

    const dateB = b.kickoff
      ? new Date(b.kickoff).getTime()
      : 0;

    return dateB - dateA;
  });

  const selected =
    historicalMatches.slice(
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
          message:
            "Stats returned but xG fields were not found",
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
    teamXG:
      finalizeTeamXG(teamAccumulator),

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

function enrichMatches(
  matches,
  details
) {
  const detailMap = new Map();

  for (const detail of details) {
    detailMap.set(detail.id, detail);
  }

  return matches.map((match) => {
    const detail =
      detailMap.get(match.id);

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

      detailErrors:
        detail.errors || [],
    };
  });
}

export default async function handler(
  req,
  res
) {
  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const generatedAt =
    new Date().toISOString();

  try {
    if (!getApiKey()) {
      return res.status(500).json({
        ok: false,
        error:
          "BBS_API_KEY non configurata",
      });
    }

    const matches =
      await getCurrentMatches();

    const futureDetails =
      await getFutureDetails(matches);

    const historical =
      await getHistoricalXG();

    const standingsResult =
      await getStandings();

    const enrichedMatches =
      enrichMatches(
        matches,
        futureDetails
      );

    const directXGCount =
      enrichedMatches.filter(
        (match) =>
          match.xG &&
          match.xG.home !== null &&
          match.xG.away !== null
      ).length;

    const lineupCount =
      enrichedMatches.filter(
        (match) =>
          Array.isArray(match.lineups) &&
          match.lineups.length > 0
      ).length;

    const detailErrors =
      futureDetails
        .filter(
          (detail) =>
            Array.isArray(
              detail.errors
            ) &&
            detail.errors.length > 0
        )
        .map((detail) => ({
          matchId: detail.id,
          errors: detail.errors,
        }));

    return res.status(200).json({
      ok: true,

      source:
        "Big Balls Sports Data",

      league: LEAGUE,

      generatedAt,

      coverage: {
        matches:
          enrichedMatches.length,

        detailsAttempted:
          futureDetails.length,

        xG:
          historical.xGCount,

        directMatchXG:
          directXGCount,

        lineups:
          lineupCount,

        standings:
          standingsResult
            .standings.length,

        historicalMatches:
          historical
            .historicalMatches.length,

        teamsWithXG:
          Object.keys(
            historical.teamXG
          ).length,
      },

      teamXG:
        historical.teamXG,

      diagnostics: {
        apiKeyDetected: true,

        standingsAvailable:
          standingsResult
            .standings.length > 0,

        standingsError:
          standingsResult.error,

        detailErrors,

        historicalErrors:
          historical.diagnostics,
      },

      matches:
        enrichedMatches,

      standings:
        standingsResult.standings,
    });
  } catch (error) {
    console.error(
      "SYNC ERROR",
      error
    );

    return res.status(500).json({
      ok: false,

      error:
        error?.message ||
        "Errore durante sincronizzazione BBS",

      generatedAt,

      diagnostics: {
        apiKeyDetected:
          Boolean(getApiKey()),

        status:
          error?.status || null,

        body:
          typeof error?.body === "string"
            ? error.body.slice(
                0,
                1000
              )
            : error?.body || null,
      },
    });
  }
}
