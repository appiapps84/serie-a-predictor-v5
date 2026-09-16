const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const SPORT = "football";
const LEAGUE = "seriea";

/*
 * Limiti volutamente bassi:
 *
 * 1 richiesta matches
 * 1 richiesta standings
 * max 8 richieste stats/xG
 * max 6 richieste lineups
 *
 * Totale massimo: 16 richieste per sync.
 */
const MATCH_TIMEOUT = 8000;
const OPTIONAL_TIMEOUT = 6000;

const MAX_STATS_REQUESTS = 8;
const MAX_LINEUP_REQUESTS = 6;


/* =========================================================
   FETCH BBD
========================================================= */

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

    const response = await fetch(
      `${BBS_BASE}${path}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-API-Key": API_KEY,
          Authorization: `Bearer ${API_KEY}`
        },
        signal: controller.signal
      }
    );

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


/* =========================================================
   ARRAY EXTRACTION
========================================================= */

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

  if (
    data.data &&
    typeof data.data === "object"
  ) {

    for (const key of keys) {

      if (Array.isArray(data.data[key])) {
        return data.data[key];
      }
    }
  }

  return [];
}


/* =========================================================
   MATCH ID
========================================================= */

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


/* =========================================================
   MATCH STATUS
========================================================= */

function getMatchStatus(match) {

  if (!match || typeof match !== "object") {
    return "";
  }

  return String(
    match.status ??
    match.state ??
    match.match_status ??
    ""
  ).toLowerCase();
}


/* =========================================================
   PARTITA TERMINATA?
========================================================= */

function isCompletedMatch(match) {

  const status =
    getMatchStatus(match);

  /*
   * BBD può usare diversi stati.
   */

  const completedStatuses = [
    "finished",
    "ft",
    "full_time",
    "completed",
    "complete",
    "ended",
    "final"
  ];

  if (
    completedStatuses.some(
      value => status.includes(value)
    )
  ) {
    return true;
  }

  /*
   * Alcuni feed usano semplicemente un
   * punteggio finale.
   */

  const score =
    match?.score ??
    match?.scores ??
    match?.result ??
    null;

  if (score && typeof score === "object") {

    const home =
      score.home ??
      score.home_score ??
      score.homeScore;

    const away =
      score.away ??
      score.away_score ??
      score.awayScore;

    if (
      home !== undefined &&
      away !== undefined &&
      home !== null &&
      away !== null
    ) {
      return true;
    }
  }

  return false;
}


/* =========================================================
   NUMERO SICURO
========================================================= */

function numberOrNull(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}


/* =========================================================
   ESTRAZIONE XG
========================================================= */

function findXGInObject(obj) {

  if (!obj || typeof obj !== "object") {
    return null;
  }

  /*
   * Formati possibili:
   *
   * home_xg / away_xg
   * homeXG / awayXG
   * xg_home / xg_away
   * expected_goals_home / expected_goals_away
   */

  const homeCandidates = [
    obj.home_xg,
    obj.homeXG,
    obj.home_xG,
    obj.xg_home,
    obj.xG_home,
    obj.expected_goals_home,
    obj.expectedGoalsHome,
    obj.home_expected_goals,
    obj.homeExpectedGoals
  ];

  const awayCandidates = [
    obj.away_xg,
    obj.awayXG,
    obj.away_xG,
    obj.xg_away,
    obj.xG_away,
    obj.expected_goals_away,
    obj.expectedGoalsAway,
    obj.away_expected_goals,
    obj.awayExpectedGoals
  ];

  let home = null;
  let away = null;

  for (const value of homeCandidates) {

    const number =
      numberOrNull(value);

    if (
      number !== null &&
      number >= 0 &&
      number <= 15
    ) {
      home = number;
      break;
    }
  }

  for (const value of awayCandidates) {

    const number =
      numberOrNull(value);

    if (
      number !== null &&
      number >= 0 &&
      number <= 15
    ) {
      away = number;
      break;
    }
  }

  if (
    home !== null &&
    away !== null
  ) {

    return {
      homeXG: home,
      awayXG: away
    };
  }

  /*
   * Possibile oggetto annidato xG:
   */

  const nestedCandidates = [
    obj.xG,
    obj.xg,
    obj.expected_goals,
    obj.expectedGoals,
    obj.stats,
    obj.statistics,
    obj.match_stats,
    obj.matchStats
  ];

  for (const nested of nestedCandidates) {

    if (
      nested &&
      typeof nested === "object"
    ) {

      const result =
        findXGInObject(nested);

      if (result) {
        return result;
      }
    }
  }

  return null;
}


/* =========================================================
   XG DA RISPOSTA STATS
========================================================= */

function extractXG(data) {

  if (!data) {
    return null;
  }

  /*
   * Prova direttamente.
   */

  const direct =
    findXGInObject(data);

  if (direct) {
    return direct;
  }

  /*
   * Prova array.
   */

  const arrays = [
    data.stats,
    data.statistics,
    data.data,
    data.match,
    data.fixture
  ];

  for (const item of arrays) {

    if (Array.isArray(item)) {

      for (const row of item) {

        const result =
          findXGInObject(row);

        if (result) {
          return result;
        }
      }

    } else if (
      item &&
      typeof item === "object"
    ) {

      const result =
        findXGInObject(item);

      if (result) {
        return result;
      }
    }
  }

  return null;
}


/* =========================================================
   STATS ENDPOINT
========================================================= */

async function fetchMatchStats(matchId) {

  if (!matchId) {
    return {
      ok: false,
      status: 400,
      xG: null,
      data: null
    };
  }

  /*
   * Endpoint documentato BBD:
   *
   * /v1/stored/matches/:id/stats
   */

  const result =
    await fetchBBS(
      `/v1/stored/matches/${encodeURIComponent(matchId)}/stats?sport=${SPORT}`,
      OPTIONAL_TIMEOUT
    );

  return {
    ...result,
    xG: result.ok
      ? extractXG(result.data)
      : null
  };
}


/* =========================================================
   LINEUP ENDPOINT
========================================================= */

async function fetchMatchLineup(matchId) {

  if (!matchId) {
    return {
      ok: false,
      status: 400,
      data: null
    };
  }

  /*
   * Endpoint documentato BBD:
   *
   * /v1/stored/matches/:id/lineups
   */

  return fetchBBS(
    `/v1/stored/matches/${encodeURIComponent(matchId)}/lineups?sport=${SPORT}`,
    OPTIONAL_TIMEOUT
  );
}


/* =========================================================
   LIMIT ARRAY
========================================================= */

function takeLimited(array, max) {

  return Array.isArray(array)
    ? array.slice(0, max)
    : [];
}


/* =========================================================
   MAIN
========================================================= */

async function run(res) {

  const started =
    Date.now();

  const diagnostics = {

    apiKeyDetected:
      Boolean(API_KEY),

    requests: 0,

    matches: {
      status: null,
      elapsedMs: null
    },

    standings: {
      status: null,
      elapsedMs: null
    },

    stats: {
      requested: 0,
      successful: 0,
      withXG: 0,
      errors: 0
    },

    lineups: {
      requested: 0,
      successful: 0,
      errors: 0
    }
  };


  /* =======================================================
     API KEY
  ======================================================= */

  if (!API_KEY) {

    return res.status(500).json({

      ok: false,

      error:
        "BBS_API_KEY non configurata su Vercel.",

      diagnostics
    });
  }


  /* =======================================================
     MATCHES
  ======================================================= */

  const matchesStarted =
    Date.now();

  diagnostics.requests++;

  const matchesResult =
    await fetchBBS(
      `/v1/matches?sport=${SPORT}&league=${LEAGUE}`,
      MATCH_TIMEOUT
    );

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


  /* =======================================================
     STANDINGS
  ======================================================= */

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


  /* =======================================================
     CANDIDATE MATCHES PER XG
  ======================================================= */

  /*
   * Prima proviamo le partite completate.
   *
   * Se BBD non restituisce uno status chiaro,
   * prendiamo comunque le prime partite che
   * possiedono un id.
   */

  let completedMatches =
    matches.filter(isCompletedMatch);


  if (!completedMatches.length) {

    completedMatches =
      matches.filter(
        match => Boolean(getMatchId(match))
      );
  }


  const statsCandidates =
    takeLimited(
      completedMatches,
      MAX_STATS_REQUESTS
    );


  /* =======================================================
     XG
  ======================================================= */

  const teamXG = {};

  const matchXG = [];

  for (const match of statsCandidates) {

    if (
      diagnostics.stats.requested >=
      MAX_STATS_REQUESTS
    ) {
      break;
    }

    const matchId =
      getMatchId(match);

    if (!matchId) {
      continue;
    }

    diagnostics.stats.requested++;
    diagnostics.requests++;

    const statsResult =
      await fetchMatchStats(matchId);

    if (!statsResult.ok) {

      diagnostics.stats.errors++;

      /*
       * 429:
       * non continuiamo a martellare BBD.
       */
      if (statsResult.status === 429) {
        break;
      }

      continue;
    }

    diagnostics.stats.successful++;

    if (statsResult.xG) {

      diagnostics.stats.withXG++;

      const xg =
        statsResult.xG;

      const homeName =
        match?.home?.name ??
        match?.home_team?.name ??
        match?.home_team ??
        match?.homeTeam ??
        "";

      const awayName =
        match?.away?.name ??
        match?.away_team?.name ??
        match?.away_team ??
        match?.awayTeam ??
        "";

      matchXG.push({

        matchId,

        homeTeam:
          homeName,

        awayTeam:
          awayName,

        homeXG:
          Number(xg.homeXG.toFixed(3)),

        awayXG:
          Number(xg.awayXG.toFixed(3)),

        source:
          "BBD stored match stats"
      });


      /*
       * Salviamo anche una media semplice
       * per squadra.
       *
       * Viene usata dal predictor come fallback
       * se la partita selezionata non possiede
       * xG diretto.
       */

      const homeKey =
        String(homeName)
          .trim()
          .toLowerCase();

      const awayKey =
        String(awayName)
          .trim()
          .toLowerCase();


      if (homeKey) {

        if (!teamXG[homeKey]) {

          teamXG[homeKey] = {
            sum: 0,
            count: 0
          };
        }

        teamXG[homeKey].sum +=
          xg.homeXG;

        teamXG[homeKey].count++;
      }


      if (awayKey) {

        if (!teamXG[awayKey]) {

          teamXG[awayKey] = {
            sum: 0,
            count: 0
          };
        }

        teamXG[awayKey].sum +=
          xg.awayXG;

        teamXG[awayKey].count++;
      }
    }
  }


  /*
   * Convertiamo:
   *
   * {
   *   sum,
   *   count
   * }
   *
   * in:
   *
   * {
   *   "inter milan": 1.72
   * }
   */

  const normalizedTeamXG = {};

  for (
    const [team, value]
    of Object.entries(teamXG)
  ) {

    if (
      value &&
      value.count > 0
    ) {

      normalizedTeamXG[team] =
        Number(
          (
            value.sum /
            value.count
          ).toFixed(3)
        );
    }
  }


  /* =======================================================
     LINEUPS
  ======================================================= */

  /*
   * Le lineups sono utili soprattutto per
   * partite vicine al calcio d'inizio.
   *
   * Limitiamo a 6 richieste.
   */

  const lineupCandidates =
    takeLimited(
      matches.filter(
        match => Boolean(getMatchId(match))
      ),
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

    if (!matchId) {
      continue;
    }

    diagnostics.lineups.requested++;
    diagnostics.requests++;

    const lineupResult =
      await fetchMatchLineup(matchId);

    if (!lineupResult.ok) {

      diagnostics.lineups.errors++;

      if (lineupResult.status === 429) {
        break;
      }

      continue;
    }

    diagnostics.lineups.successful++;

    lineups.push({

      matchId,

      data:
        lineupResult.data
    });
  }


  /* =======================================================
     COVERAGE
  ======================================================= */

  const coverage = {

    matches:
      matches.length,

    xG:
      matchXG.length,

    teamsWithXG:
      Object.keys(normalizedTeamXG).length,

    lineups:
      lineups.length,

    standings:
      standings.length
  };


  /* =======================================================
     RESPONSE
  ======================================================= */

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

    /*
     * xG delle singole partite.
     */
    matchXG,

    /*
     * xG medio per squadra.
     */
    teamXG:
      normalizedTeamXG,

    lineups,

    standings,

    diagnostics: {

      ...diagnostics,

      totalElapsedMs:
        Date.now() - started
    }
  });
}


/* =========================================================
   HANDLER VERCEL
========================================================= */

export default async function handler(req, res) {

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


  if (req.method === "OPTIONS") {

    return res.status(204).end();
  }


  if (req.method !== "GET") {

    return res.status(405).json({

      ok: false,

      error:
        "METHOD_NOT_ALLOWED",

      message:
        "Usa GET per /api/sync."
    });
  }


  try {

    return await run(res);

  } catch (error) {

    console.error(
      "Sync fatal error:",
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
