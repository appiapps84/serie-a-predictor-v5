const BBS_BASE = "https://api.bigballsdata.com";

const SPORT = "football";
const LEAGUE = "seriea";
const YEAR = 2025;

const MAX_CANDIDATE_MATCHES = 30;
const MAX_TEST_MATCHES = 10;
const MAX_STATS_REQUESTS = 10;

const LIST_TIMEOUT = 8000;
const STATS_TIMEOUT = 8000;

const MAX_GOALS = 10;
const DIXON_COLES_RHO = -0.08;

const ALIASES = {
  "inter milan": "inter",
  "internazionale": "inter",
  "como 1907": "como",
  "as roma": "roma",
  "ac milan": "milan",
  "venezia fc": "venezia"
};

function normalizeName(value) {
  const raw = String(value || "").trim().toLowerCase();
  return ALIASES[raw] || raw;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, timeout = 8000) {
  const apiKey = process.env.BBS_API_KEY;

  if (!apiKey) {
    throw new Error("BBS_API_KEY non configurata.");
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `Risposta non JSON da BBD (${response.status})`
    );
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ||
      payload?.message ||
      `BBD HTTP ${response.status}`
    );

    error.status = response.status;
    error.payload = payload;
    error.retryAfter =
      Number(response.headers.get("retry-after")) || 0;

    throw error;
  }

  return payload;
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function extractTeamName(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (value && typeof value === "object") {
    return String(
      value.name ||
      value.team_name ||
      value.teamName ||
      value.short_name ||
      value.shortName ||
      value.display_name ||
      ""
    ).trim();
  }

  return "";
}

function extractHomeTeam(match) {
  return extractTeamName(
    match?.home ||
    match?.home_team ||
    match?.homeTeam ||
    match?.teams?.home
  );
}

function extractAwayTeam(match) {
  return extractTeamName(
    match?.away ||
    match?.away_team ||
    match?.awayTeam ||
    match?.teams?.away
  );
}

function extractDate(match) {
  const value =
    match?.kickoff_utc ||
    match?.kickoff ||
    match?.date ||
    match?.start_time ||
    match?.startTime ||
    match?.scheduled_at ||
    match?.scheduledAt ||
    match?.game_date ||
    null;

  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function extractScore(match) {
  const score =
    match?.score ||
    match?.scores ||
    match?.result ||
    null;

  if (!score) return null;

  const home =
    number(score.home) ??
    number(score.home_score) ??
    number(score.homeScore) ??
    number(score.home_goals) ??
    number(score.homeGoals);

  const away =
    number(score.away) ??
    number(score.away_score) ??
    number(score.awayScore) ??
    number(score.away_goals) ??
    number(score.awayGoals);

  if (home === null || away === null) {
    return null;
  }

  return { home, away };
}

function normalizeMatch(match) {
  return {
    id: String(
      match?.id ||
      match?.match_id ||
      match?.matchId ||
      ""
    ).trim(),

    homeTeam: extractHomeTeam(match),
    awayTeam: extractAwayTeam(match),
    date: extractDate(match),
    score: extractScore(match),
    xG: null
  };
}

function isValidMatch(match) {
  return Boolean(
    match.id &&
    match.homeTeam &&
    match.awayTeam &&
    match.date &&
    match.score
  );
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function monthDays(year, month) {
  return new Date(
    Date.UTC(year, month + 1, 0)
  ).getUTCDate();
}

/*
 * Recupera tutto il 2025.
 *
 * Prima prova il range mensile.
 * Se BBD non restituisce risultati per il range,
 * usa il filtro date giornaliero.
 *
 * Questa parte non fa chiamate stats:
 * sono le chiamate costose che vogliamo limitare.
 */
async function fetch2025Matches() {
  const rawRows = [];
  const diagnostics = [];

  for (let month = 0; month < 12; month++) {
    const firstDay =
      `${YEAR}-${String(month + 1).padStart(2, "0")}-01`;

    const lastDay =
      `${YEAR}-${String(month + 1).padStart(2, "0")}-${String(
        monthDays(YEAR, month)
      ).padStart(2, "0")}`;

    let rangeWorked = false;

    const rangeUrl =
      `${BBS_BASE}/v1/stored/matches` +
      `?sport=${SPORT}` +
      `&league=${LEAGUE}` +
      `&status=finished` +
      `&date_from=${firstDay}` +
      `&date_to=${lastDay}` +
      `&limit=200`;

    try {
      const payload =
        await fetchJson(
          rangeUrl,
          LIST_TIMEOUT
        );

      const rows =
        extractArray(payload);

      const valid =
        rows.filter(row => {
          const date =
            extractDate(row);

          return (
            date &&
            date.getUTCFullYear() === YEAR &&
            date.getUTCMonth() === month
          );
        });

      if (valid.length > 0) {
        rawRows.push(...valid);
        rangeWorked = true;
      }
    } catch (error) {
      /*
       * Fallback sotto.
       */
    }

    /*
     * Fallback giornaliero.
     *
     * Non viene eseguito se il range mensile
     * ha restituito dati.
     */
    if (!rangeWorked) {
      const days =
        monthDays(YEAR, month);

      for (let day = 1; day <= days; day++) {
        const date =
          `${YEAR}-${String(month + 1).padStart(2, "0")}-${String(
            day
          ).padStart(2, "0")}`;

        const url =
          `${BBS_BASE}/v1/stored/matches` +
          `?sport=${SPORT}` +
          `&league=${LEAGUE}` +
          `&status=finished` +
          `&date=${date}` +
          `&limit=200`;

        try {
          const payload =
            await fetchJson(
              url,
              LIST_TIMEOUT
            );

          rawRows.push(
            ...extractArray(payload)
          );
        } catch (error) {
          /*
           * Un singolo giorno non blocca
           * l'intero backtest.
           */
        }
      }
    }

    diagnostics.push({
      month: month + 1,
      range: `${firstDay} → ${lastDay}`,
      mode: rangeWorked ? "range" : "daily"
    });
  }

  return {
    rawRows,
    diagnostics
  };
}

function uniqueMatches(rows) {
  const map = new Map();

  for (const raw of rows) {
    const match =
      normalizeMatch(raw);

    if (!isValidMatch(match)) {
      continue;
    }

    if (
      match.date.getUTCFullYear() !== YEAR
    ) {
      continue;
    }

    if (!map.has(match.id)) {
      map.set(match.id, match);
    }
  }

  return Array.from(map.values())
    .sort(
      (a, b) =>
        a.date.getTime() -
        b.date.getTime()
    );
}

/*
 * Cerca xG nella risposta stats.
 */
function extractXG(payload, homeTeam, awayTeam) {
  const data =
    payload?.data ??
    payload;

  if (!data) {
    return null;
  }

  /*
   * Formato diretto.
   */
  const homeCandidates = [
    data?.home?.xg,
    data?.home?.XG,
    data?.home?.expected_goals,
    data?.home?.expectedGoals,
    data?.home_xg,
    data?.homeXG,
    data?.expected_goals_home,
    data?.expectedGoalsHome
  ];

  const awayCandidates = [
    data?.away?.xg,
    data?.away?.XG,
    data?.away?.expected_goals,
    data?.away?.expectedGoals,
    data?.away_xg,
    data?.awayXG,
    data?.expected_goals_away,
    data?.expectedGoalsAway
  ];

  let homeXG = null;
  let awayXG = null;

  for (const value of homeCandidates) {
    const n = number(value);

    if (
      n !== null &&
      n >= 0 &&
      n <= 10
    ) {
      homeXG = n;
      break;
    }
  }

  for (const value of awayCandidates) {
    const n = number(value);

    if (
      n !== null &&
      n >= 0 &&
      n <= 10
    ) {
      awayXG = n;
      break;
    }
  }

  if (
    homeXG !== null &&
    awayXG !== null
  ) {
    return {
      home: homeXG,
      away: awayXG,
      source: "direct"
    };
  }

  /*
   * Formato team_stats.
   */
  const teamStats =
    Array.isArray(data?.team_stats)
      ? data.team_stats
      : Array.isArray(data?.teamStats)
        ? data.teamStats
        : [];

  if (teamStats.length > 0) {
    let foundHome = null;
    let foundAway = null;

    for (const row of teamStats) {
      const team =
        extractTeamName(
          row?.team ||
          row?.team_name ||
          row?.teamName ||
          row?.name
        );

      const xg =
        number(row?.xg) ??
        number(row?.XG) ??
        number(row?.expected_goals) ??
        number(row?.expectedGoals);

      if (
        xg === null ||
        xg < 0 ||
        xg > 10
      ) {
        continue;
      }

      const normalized =
        normalizeName(team);

      if (
        normalized ===
        normalizeName(homeTeam)
      ) {
        foundHome = xg;
      }

      if (
        normalized ===
        normalizeName(awayTeam)
      ) {
        foundAway = xg;
      }
    }

    if (
      foundHome !== null &&
      foundAway !== null
    ) {
      return {
        home: foundHome,
        away: foundAway,
        source: "team_stats"
      };
    }
  }

  return null;
}

/*
 * Recupera xG di una singola partita.
 *
 * NON fa retry automatici su 429.
 * Se arriva 429, interrompe il ciclo
 * principale per proteggere la quota.
 */
async function fetchMatchXG(match) {
  const url =
    `${BBS_BASE}/v1/stored/matches/` +
    `${encodeURIComponent(match.id)}/stats`;

  try {
    const payload =
      await fetchJson(
        url,
        STATS_TIMEOUT
      );

    const xG =
      extractXG(
        payload,
        match.homeTeam,
        match.awayTeam
      );

    if (!xG) {
      return {
        ok: false,
        rateLimited: false,
        reason:
          payload?.meta?.coverage_note ||
          "xG non presente",
        payloadMeta:
          payload?.meta || null
      };
    }

    return {
      ok: true,
      rateLimited: false,
      xG
    };
  } catch (error) {
    if (
      error?.status === 429
    ) {
      return {
        ok: false,
        rateLimited: true,
        retryAfter:
          error.retryAfter || 0,
        reason:
          error.message
      };
    }

    return {
      ok: false,
      rateLimited: false,
      reason:
        error?.message ||
        "Errore stats"
    };
  }
}

function getRecentMatches(
  history,
  teamName,
  beforeDate,
  limit = 5
) {
  const wanted =
    normalizeName(teamName);

  return history
    .filter(match => {
      if (!match.date) {
        return false;
      }

      if (
        match.date >= beforeDate
      ) {
        return false;
      }

      return (
        normalizeName(match.homeTeam) ===
          wanted ||
        normalizeName(match.awayTeam) ===
          wanted
      );
    })
    .sort(
      (a, b) =>
        b.date.getTime() -
        a.date.getTime()
    )
    .slice(0, limit);
}

function getForm(
  history,
  teamName,
  beforeDate
) {
  const rows =
    getRecentMatches(
      history,
      teamName,
      beforeDate,
      5
    );

  if (rows.length === 0) {
    return null;
  }

  const wanted =
    normalizeName(teamName);

  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;

  for (const match of rows) {
    const isHome =
      normalizeName(
        match.homeTeam
      ) === wanted;

    const gf =
      isHome
        ? match.score.home
        : match.score.away;

    const ga =
      isHome
        ? match.score.away
        : match.score.home;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) {
      points += 3;
    } else if (gf === ga) {
      points += 1;
    }
  }

  return {
    matches: rows.length,
    goalsForPerGame:
      goalsFor / rows.length,
    goalsAgainstPerGame:
      goalsAgainst / rows.length,
    pointsPerGame:
      points / rows.length
  };
}

function getRollingXG(
  history,
  teamName,
  beforeDate
) {
  const rows =
    getRecentMatches(
      history,
      teamName,
      beforeDate,
      5
    ).filter(
      match =>
        match.xG &&
        number(match.xG.home) !== null &&
        number(match.xG.away) !== null
    );

  if (rows.length === 0) {
    return null;
  }

  const wanted =
    normalizeName(teamName);

  let xGFor = 0;
  let xGAgainst = 0;

  for (const match of rows) {
    const isHome =
      normalizeName(
        match.homeTeam
      ) === wanted;

    if (isHome) {
      xGFor += match.xG.home;
      xGAgainst += match.xG.away;
    } else {
      xGFor += match.xG.away;
      xGAgainst += match.xG.home;
    }
  }

  return {
    matches: rows.length,
    xGFor:
      xGFor / rows.length,
    xGAgainst:
      xGAgainst / rows.length
  };
}

function baselineModel(
  homeTeam,
  awayTeam,
  history,
  date
) {
  const homeForm =
    getForm(
      history,
      homeTeam,
      date
    );

  const awayForm =
    getForm(
      history,
      awayTeam,
      date
    );

  let homeXG = 1.35;
  let awayXG = 1.05;

  if (
    homeForm &&
    awayForm
  ) {
    homeXG =
      0.65 *
        homeForm.goalsForPerGame +
      0.35 *
        awayForm.goalsAgainstPerGame;

    awayXG =
      0.65 *
        awayForm.goalsForPerGame +
      0.35 *
        homeForm.goalsAgainstPerGame;

    homeXG *= clamp(
      0.90 +
        (homeForm.pointsPerGame / 3) *
          0.15,
      0.90,
      1.05
    );

    awayXG *= clamp(
      0.90 +
        (awayForm.pointsPerGame / 3) *
          0.15,
      0.90,
      1.05
    );
  }

  homeXG *= 1.06;

  return {
    home: clamp(
      homeXG,
      0.15,
      4.5
    ),

    away: clamp(
      awayXG,
      0.10,
      4.0
    )
  };
}

function xGModel(
  homeTeam,
  awayTeam,
  history,
  date
) {
  const baseline =
    baselineModel(
      homeTeam,
      awayTeam,
      history,
      date
    );

  const homeXG =
    getRollingXG(
      history,
      homeTeam,
      date
    );

  const awayXG =
    getRollingXG(
      history,
      awayTeam,
      date
    );

  if (
    !homeXG ||
    !awayXG
  ) {
    return {
      ...baseline,
      available: false,
      previousXGMatches: 0
    };
  }

  let homeExpected =
    baseline.home * 0.65 +
    homeXG.xGFor * 0.35;

  let awayExpected =
    baseline.away * 0.65 +
    awayXG.xGFor * 0.35;

  homeExpected *=
    0.90 +
    clamp(
      awayXG.xGAgainst / 1.20,
      0.80,
      1.20
    ) * 0.10;

  awayExpected *=
    0.90 +
    clamp(
      homeXG.xGAgainst / 1.20,
      0.80,
      1.20
    ) * 0.10;

  return {
    home: clamp(
      homeExpected,
      0.15,
      4.5
    ),

    away: clamp(
      awayExpected,
      0.10,
      4.0
    ),

    available: true,

    previousXGMatches:
      Math.min(
        homeXG.matches,
        awayXG.matches
      )
  };
}

function poisson(k, lambda) {
  if (
    !Number.isFinite(lambda) ||
    lambda <= 0
  ) {
    return k === 0 ? 1 : 0;
  }

  let factorial = 1;

  for (
    let i = 2;
    i <= k;
    i++
  ) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial
  );
}

function dixonColes(
  h,
  a,
  homeXG,
  awayXG
) {
  const rho =
    DIXON_COLES_RHO;

  if (h === 0 && a === 0) {
    return (
      1 -
      homeXG *
        awayXG *
        rho
    );
  }

  if (h === 0 && a === 1) {
    return 1 + homeXG * rho;
  }

  if (h === 1 && a === 0) {
    return 1 + awayXG * rho;
  }

  if (h === 1 && a === 1) {
    return 1 - rho;
  }

  return 1;
}

function buildMatrix(
  homeXG,
  awayXG
) {
  const matrix = [];
  let total = 0;

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    matrix[h] = [];

    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      const p =
        poisson(h, homeXG) *
        poisson(a, awayXG) *
        dixonColes(
          h,
          a,
          homeXG,
          awayXG
        );

      matrix[h][a] =
        Math.max(0, p);

      total +=
        matrix[h][a];
    }
  }

  if (total > 0) {
    for (
      let h = 0;
      h <= MAX_GOALS;
      h++
    ) {
      for (
        let a = 0;
        a <= MAX_GOALS;
        a++
      ) {
        matrix[h][a] /=
          total;
      }
    }
  }

  return matrix;
}

function getProbabilities(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      const p =
        matrix[h][a] || 0;

      if (h > a) {
        home += p;
      } else if (h === a) {
        draw += p;
      } else {
        away += p;
      }
    }
  }

  return {
    home,
    draw,
    away
  };
}

function actualResult(score) {
  if (
    score.home >
    score.away
  ) {
    return "home";
  }

  if (
    score.home ===
    score.away
  ) {
    return "draw";
  }

  return "away";
}

function predictedResult(p) {
  if (
    p.home >= p.draw &&
    p.home >= p.away
  ) {
    return "home";
  }

  if (
    p.draw >= p.home &&
    p.draw >= p.away
  ) {
    return "draw";
  }

  return "away";
}

function brier(p, actual) {
  return (
    Math.pow(
      p.home -
        (actual === "home" ? 1 : 0),
      2
    ) +
    Math.pow(
      p.draw -
        (actual === "draw" ? 1 : 0),
      2
    ) +
    Math.pow(
      p.away -
        (actual === "away" ? 1 : 0),
      2
    )
  );
}

function logLoss(p, actual) {
  const epsilon = 0.000001;

  return -Math.log(
    Math.max(
      epsilon,
      p[actual]
    )
  );
}

function addMetric(
  metrics,
  probabilities,
  actual
) {
  metrics.matches++;

  if (
    predictedResult(
      probabilities
    ) === actual
  ) {
    metrics.correct++;
  }

  metrics.brier +=
    brier(
      probabilities,
      actual
    );

  metrics.logLoss +=
    logLoss(
      probabilities,
      actual
    );
}

function finalize(metrics) {
  if (
    metrics.matches === 0
  ) {
    return {
      matches: 0,
      accuracy: null,
      brierScore: null,
      logLoss: null
    };
  }

  return {
    matches:
      metrics.matches,

    accuracy:
      Number(
        (
          metrics.correct /
          metrics.matches
        ).toFixed(4)
      ),

    brierScore:
      Number(
        (
          metrics.brier /
          metrics.matches
        ).toFixed(4)
      ),

    logLoss:
      Number(
        (
          metrics.logLoss /
          metrics.matches
        ).toFixed(4)
      )
  };
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message:
        "Usa GET per /api/backtest."
    });
  }

  if (!process.env.BBS_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
      message:
        "BBS_API_KEY non configurata."
    });
  }

  try {
    /*
     * ==========================================
     * 1. CARICAMENTO PARTITE 2025
     * ==========================================
     */

    const {
      rawRows,
      diagnostics: monthDiagnostics
    } = await fetch2025Matches();

    const allMatches =
      uniqueMatches(rawRows);

    /*
     * Partiamo dalle partite più recenti.
     *
     * Questo aumenta la probabilità di trovare
     * stats/xG disponibili.
     */
    const candidates =
      allMatches
        .slice(
          Math.max(
            0,
            allMatches.length -
              MAX_CANDIDATE_MATCHES
          )
        )
        .reverse();

    /*
     * ==========================================
     * 2. TEST xG
     * ==========================================
     *
     * MASSIMO 10 chiamate.
     *
     * Non facciamo retry automatici.
     * Se BBD restituisce 429, STOP immediato.
     */

    const statsDiagnostics = [];

    const xGMatches = [];

    let statsRequests = 0;
    let statsUnavailable = 0;
    let statsErrors = 0;
    let rateLimited = false;
    let retryAfter = 0;

    for (
      const match of candidates
    ) {
      if (
        statsRequests >=
        MAX_STATS_REQUESTS
      ) {
        break;
      }

      /*
       * Piccola pausa per evitare burst.
       *
       * Non aspettiamo 1 minuto:
       * il limite è 100/min e noi siamo
       * molto sotto quel limite.
       */
      if (statsRequests > 0) {
        await sleep(800);
      }

      statsRequests++;

      const result =
        await fetchMatchXG(
          match
        );

      if (result.ok) {
        match.xG = result.xG;

        xGMatches.push(
          match
        );

        statsDiagnostics.push({
          id: match.id,
          date:
            dateKey(match.date),
          home:
            match.homeTeam,
          away:
            match.awayTeam,
          xG: true,
          homeXG:
            result.xG.home,
          awayXG:
            result.xG.away,
          source:
            result.xG.source
        });

        continue;
      }

      if (
        result.rateLimited
      ) {
        rateLimited = true;

        retryAfter =
          result.retryAfter || 0;

        statsDiagnostics.push({
          id: match.id,
          date:
            dateKey(match.date),
          home:
            match.homeTeam,
          away:
            match.awayTeam,
          xG: false,
          rateLimited: true,
          retryAfter,
          reason:
            result.reason
        });

        /*
         * STOP.
         *
         * Importantissimo:
         * non continuiamo a bombardare BBD.
         */
        break;
      }

      /*
       * Stats endpoint ha risposto,
       * ma senza xG.
       */
      if (
        result.reason
      ) {
        statsUnavailable++;

        statsDiagnostics.push({
          id: match.id,
          date:
            dateKey(match.date),
          home:
            match.homeTeam,
          away:
            match.awayTeam,
          xG: false,
          reason:
            result.reason
        });
      } else {
        statsErrors++;
      }
    }

    /*
     * ==========================================
     * 3. BACKTEST
     * ==========================================
     *
     * Per fare un confronto con xG abbiamo
     * bisogno di almeno una finestra storica.
     *
     * Per questa v2 usiamo solo le partite
     * che abbiamo realmente interrogato.
     *
     * Non inventiamo xG mancanti.
     */

    const history =
      allMatches
        .filter(match =>
          match.date
        )
        .sort(
          (a, b) =>
            a.date.getTime() -
            b.date.getTime()
        );

    const testMatches =
      xGMatches
        .sort(
          (a, b) =>
            a.date.getTime() -
            b.date.getTime()
        )
        .slice(
          0,
          MAX_TEST_MATCHES
        );

    const baselineMetrics = {
      matches: 0,
      correct: 0,
      brier: 0,
      logLoss: 0
    };

    const xGMetrics = {
      matches: 0,
      correct: 0,
      brier: 0,
      logLoss: 0
    };

    const results = [];

    for (
      const match of testMatches
    ) {
      /*
       * SOLO dati precedenti alla partita.
       */
      const previous =
        history.filter(
          previousMatch =>
            previousMatch.date <
            match.date
        );

      /*
       * Baseline.
       */
      const baseline =
        baselineModel(
          match.homeTeam,
          match.awayTeam,
          previous,
          match.date
        );

      /*
       * Modello xG.
       *
       * L'xG della partita target NON
       * viene usato per costruire la previsione.
       * Serve esclusivamente come dato
       * storico post-partita.
       */
      const xG =
        xGModel(
          match.homeTeam,
          match.awayTeam,
          history,
          match.date
        );

      const baselineMatrix =
        buildMatrix(
          baseline.home,
          baseline.away
        );

      const xGMatrix =
        buildMatrix(
          xG.home,
          xG.away
        );

      const baselineProbabilities =
        getProbabilities(
          baselineMatrix
        );

      const xGProbabilities =
        getProbabilities(
          xGMatrix
        );

      const actual =
        actualResult(
          match.score
        );

      addMetric(
        baselineMetrics,
        baselineProbabilities,
        actual
      );

      if (
        xG.available
      ) {
        addMetric(
          xGMetrics,
          xGProbabilities,
          actual
        );
      }

      results.push({
        date:
          dateKey(match.date),

        home:
          match.homeTeam,

        away:
          match.awayTeam,

        score:
          match.score,

        actual,

        baseline: {
          expectedGoals: {
            home:
              Number(
                baseline.home.toFixed(3)
              ),
            away:
              Number(
                baseline.away.toFixed(3)
              )
          },

          probabilities:
            baselineProbabilities,

          predicted:
            predictedResult(
              baselineProbabilities
            ),

          correct:
            predictedResult(
              baselineProbabilities
            ) === actual
        },

        withXG: {
          available:
            xG.available,

          previousXGMatches:
            xG.previousXGMatches ||
            0,

          expectedGoals: {
            home:
              Number(
                xG.home.toFixed(3)
              ),
            away:
              Number(
                xG.away.toFixed(3)
              )
          },

          probabilities:
            xGProbabilities,

          predicted:
            predictedResult(
              xGProbabilities
            ),

          correct:
            predictedResult(
              xGProbabilities
            ) === actual
        }
      });
    }

    const baselineFinal =
      finalize(
        baselineMetrics
      );

    const xGFinal =
      finalize(
        xGMetrics
      );

    /*
     * Per Brier e LogLoss:
     * valori più bassi = meglio.
     *
     * Quindi:
     * negativo = xG migliore
     * positivo = baseline migliore
     */
    const improvement = {
      accuracy:
        baselineFinal.accuracy !== null &&
        xGFinal.accuracy !== null
          ? Number(
              (
                xGFinal.accuracy -
                baselineFinal.accuracy
              ).toFixed(4)
            )
          : null,

      brierScore:
        baselineFinal.brierScore !== null &&
        xGFinal.brierScore !== null
          ? Number(
              (
                xGFinal.brierScore -
                baselineFinal.brierScore
              ).toFixed(4)
            )
          : null,

      logLoss:
        baselineFinal.logLoss !== null &&
        xGFinal.logLoss !== null
          ? Number(
              (
                xGFinal.logLoss -
                baselineFinal.logLoss
              ).toFixed(4)
            )
          : null
    };

    /*
     * ==========================================
     * 4. RISPOSTA
     * ==========================================
     */

    return res.status(200).json({
      ok: true,

      period: {
        year: YEAR,
        from: "2025-01-01",
        to: "2025-12-31"
      },

      model: {
        baseline:
          "Forma + gol + casa/trasferta + Poisson + Dixon-Coles",

        withXG:
          "Baseline + rolling xG storico pre-partita",

        leakageProtection:
          "Solo dati precedenti alla partita target"
      },

      dataset: {
        rawRows:
          rawRows.length,

        storedMatches2025:
          allMatches.length,

        candidateMatches:
          candidates.length,

        statsRequests,

        matchesWithXG:
          xGMatches.length,

        tested:
          testMatches.length,

        testedWithXG:
          xGMetrics.matches
      },

      metrics: {
        baseline:
          baselineFinal,

        withXG:
          xGFinal
      },

      improvement,

      results,

      diagnostics: {
        statsUnavailable,
        statsErrors,

        rateLimited,

        retryAfter,

        maxCandidateMatches:
          MAX_CANDIDATE_MATCHES,

        maxTestMatches:
          MAX_TEST_MATCHES,

        maxStatsRequests:
          MAX_STATS_REQUESTS,

        statsEndpoint:
          "/v1/stored/matches/:id/stats",

        monthDiagnostics,

        note:
          rateLimited
            ? "BBD ha restituito 429. Il backtest si è fermato immediatamente per proteggere la quota. Rispettare Retry-After prima di una nuova esecuzione."
            : "Versione v2: massimo 10 richieste stats per esecuzione, nessun retry automatico su 429."
      },

      statsDiagnostics
    });
  } catch (error) {
    console.error(
      "BACKTEST V2 ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "BACKTEST_ERROR",
      message:
        error?.message ||
        "Errore durante il backtest.",

      status:
        error?.status || null,

      retryAfter:
        error?.retryAfter || 0
    });
  }
}
