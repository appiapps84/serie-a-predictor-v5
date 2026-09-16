const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const LEAGUE = "seriea";
const SPORT = "football";

const STORED_TIMEOUT = 8000;
const STATS_TIMEOUT = 8000;

// Prima prova: 40 partite.
// Possiamo portarlo successivamente a 100, 200, 500...
const DEFAULT_MATCHES = 40;
const MAX_MATCHES = 50;

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

function poisson(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) {
    return k === 0 ? 1 : 0;
  }

  let factorial = 1;

  for (let i = 2; i <= k; i++) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial
  );
}

function dixonColesAdjustment(
  homeGoals,
  awayGoals,
  homeLambda,
  awayLambda
) {
  const rho = -0.08;

  if (homeGoals === 0 && awayGoals === 0) {
    return 1 - homeLambda * awayLambda * rho;
  }

  if (homeGoals === 0 && awayGoals === 1) {
    return 1 + homeLambda * rho;
  }

  if (homeGoals === 1 && awayGoals === 0) {
    return 1 + awayLambda * rho;
  }

  if (homeGoals === 1 && awayGoals === 1) {
    return 1 - rho;
  }

  return 1;
}

function buildMatrix(homeXG, awayXG) {
  const matrix = [];
  let total = 0;

  for (let h = 0; h <= 8; h++) {
    matrix[h] = [];

    for (let a = 0; a <= 8; a++) {
      const base =
        poisson(h, homeXG) *
        poisson(a, awayXG);

      const adjusted =
        base *
        dixonColesAdjustment(
          h,
          a,
          homeXG,
          awayXG
        );

      matrix[h][a] = Math.max(0, adjusted);
      total += matrix[h][a];
    }
  }

  if (total > 0) {
    for (let h = 0; h <= 8; h++) {
      for (let a = 0; a <= 8; a++) {
        matrix[h][a] /= total;
      }
    }
  }

  return matrix;
}

function probabilitiesFromMatrix(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;

  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = matrix[h][a] || 0;

      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }

  return { home, draw, away };
}

function extractMatches(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.matches)) {
    return payload.matches;
  }

  if (Array.isArray(payload?.data?.matches)) {
    return payload.data.matches;
  }

  return [];
}

function extractTeamName(value) {
  if (typeof value === "string") {
    return value.trim();
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

function getHomeTeam(match) {
  return extractTeamName(
    match?.home ||
    match?.home_team ||
    match?.homeTeam ||
    match?.teams?.home
  );
}

function getAwayTeam(match) {
  return extractTeamName(
    match?.away ||
    match?.away_team ||
    match?.awayTeam ||
    match?.teams?.away
  );
}

function getMatchDate(match) {
  const raw =
    match?.kickoff_utc ||
    match?.kickoff ||
    match?.date ||
    match?.start_time ||
    match?.startTime;

  if (!raw) return null;

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function getScore(match) {
  const score =
    match?.score ||
    match?.scores ||
    match?.result ||
    {};

  const home = number(
    score?.home ??
    score?.home_score ??
    score?.homeScore ??
    match?.home_score ??
    match?.homeScore
  );

  const away = number(
    score?.away ??
    score?.away_score ??
    score?.awayScore ??
    match?.away_score ??
    match?.awayScore
  );

  if (home === null || away === null) {
    return null;
  }

  return {
    home,
    away
  };
}

function isFinished(match) {
  const score = getScore(match);

  if (!score) return false;

  const status = String(
    match?.status ||
    match?.state ||
    ""
  ).toLowerCase();

  if (
    status.includes("scheduled") ||
    status.includes("upcoming") ||
    status.includes("cancel")
  ) {
    return false;
  }

  return true;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "X-API-Key": API_KEY,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Risposta non JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        `BBS ${response.status}: ${
          data?.error?.message ||
          data?.message ||
          "request failed"
        }`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Estrae xG da diverse possibili strutture BBD.
 */
function extractXG(payload) {
  const candidates = [];

  if (payload) {
    candidates.push(payload);
    candidates.push(payload.data);
    candidates.push(payload.stats);
    candidates.push(payload.data?.stats);
    candidates.push(payload.statistics);
    candidates.push(payload.data?.statistics);
  }

  let home = null;
  let away = null;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const homeObj =
      candidate.home ||
      candidate.home_team ||
      candidate.homeTeam;

    const awayObj =
      candidate.away ||
      candidate.away_team ||
      candidate.awayTeam;

    const directHome = number(
      candidate.home_xg ??
      candidate.homeXG ??
      candidate.home_xG
    );

    const directAway = number(
      candidate.away_xg ??
      candidate.awayXG ??
      candidate.away_xG
    );

    if (directHome !== null) {
      home = directHome;
    }

    if (directAway !== null) {
      away = directAway;
    }

    if (home === null && homeObj && typeof homeObj === "object") {
      home = number(
        homeObj.xg ??
        homeObj.xG ??
        homeObj.expected_goals ??
        homeObj.expectedGoals
      );
    }

    if (away === null && awayObj && typeof awayObj === "object") {
      away = number(
        awayObj.xg ??
        awayObj.xG ??
        awayObj.expected_goals ??
        awayObj.expectedGoals
      );
    }

    if (home === null && Array.isArray(candidate.teams)) {
      const homeTeam = candidate.teams.find(
        team =>
          String(team?.side || "").toLowerCase() === "home"
      );

      if (homeTeam) {
        home = number(
          homeTeam.xg ??
          homeTeam.xG ??
          homeTeam.expected_goals
        );
      }
    }

    if (away === null && Array.isArray(candidate.teams)) {
      const awayTeam = candidate.teams.find(
        team =>
          String(team?.side || "").toLowerCase() === "away"
      );

      if (awayTeam) {
        away = number(
          awayTeam.xg ??
          awayTeam.xG ??
          awayTeam.expected_goals
        );
      }
    }
  }

  if (
    home !== null &&
    away !== null &&
    home >= 0 &&
    away >= 0
  ) {
    return {
      home,
      away
    };
  }

  return null;
}

/*
 * Costruisce lo storico disponibile PRIMA
 * della partita che stiamo simulando.
 */
function buildPreMatchHistory(matches, targetDate) {
  const history = {};

  for (const match of matches) {
    const date = getMatchDate(match);

    if (!date || date >= targetDate) {
      continue;
    }

    if (!isFinished(match)) {
      continue;
    }

    const home = normalizeName(getHomeTeam(match));
    const away = normalizeName(getAwayTeam(match));
    const score = getScore(match);

    if (!home || !away || !score) {
      continue;
    }

    if (!history[home]) {
      history[home] = [];
    }

    if (!history[away]) {
      history[away] = [];
    }

    history[home].push({
      date,
      team: home,
      opponent: away,
      goalsFor: score.home,
      goalsAgainst: score.away,
      home: true
    });

    history[away].push({
      date,
      team: away,
      opponent: home,
      goalsFor: score.away,
      goalsAgainst: score.home,
      home: false
    });
  }

  return history;
}

function getTeamStats(history, team) {
  const rows = history[normalizeName(team)] || [];

  if (rows.length === 0) {
    return null;
  }

  const recent = rows
    .slice()
    .sort((a, b) => b.date - a.date)
    .slice(0, 5);

  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;

  for (const row of recent) {
    goalsFor += row.goalsFor;
    goalsAgainst += row.goalsAgainst;

    if (row.goalsFor > row.goalsAgainst) {
      points += 3;
    } else if (row.goalsFor === row.goalsAgainst) {
      points += 1;
    }
  }

  const count = recent.length;

  return {
    matches: count,
    goalsForPerGame: goalsFor / count,
    goalsAgainstPerGame: goalsAgainst / count,
    pointsPerGame: points / count
  };
}

function calculateBaseXG(
  homeStats,
  awayStats
) {
  let homeXG = 1.35;
  let awayXG = 1.05;

  if (homeStats && awayStats) {
    homeXG =
      1.45 *
      (
        0.60 *
          (homeStats.goalsForPerGame / 1.45) +
        0.40 *
          (awayStats.goalsAgainstPerGame / 1.45)
      );

    awayXG =
      1.15 *
      (
        0.60 *
          (awayStats.goalsForPerGame / 1.15) +
        0.40 *
          (homeStats.goalsAgainstPerGame / 1.15)
      );
  }

  if (homeStats) {
    homeXG *= clamp(
      0.94 +
      homeStats.pointsPerGame * 0.02,
      0.94,
      1.08
    );
  }

  if (awayStats) {
    awayXG *= clamp(
      0.94 +
      awayStats.pointsPerGame * 0.015,
      0.94,
      1.06
    );
  }

  homeXG *= 1.06;

  return {
    home: clamp(homeXG, 0.20, 4.0),
    away: clamp(awayXG, 0.15, 3.5)
  };
}

function calculateXGModel(
  base,
  historicalXG
) {
  /*
   * Gli xG storici della squadra vengono usati
   * come correzione del modello tradizionale.
   */
  if (!historicalXG) {
    return {
      home: base.home,
      away: base.away
    };
  }

  let home = base.home;
  let away = base.away;

  if (historicalXG.homeFor !== null) {
    home =
      base.home * 0.65 +
      historicalXG.homeFor * 0.35;
  }

  if (historicalXG.awayFor !== null) {
    away =
      base.away * 0.65 +
      historicalXG.awayFor * 0.35;
  }

  return {
    home: clamp(home, 0.20, 4.0),
    away: clamp(away, 0.15, 3.5)
  };
}

function resultClass(score) {
  if (score.home > score.away) return "H";
  if (score.home === score.away) return "D";
  return "A";
}

function brierScore(probabilities, actual) {
  const homeActual = actual === "H" ? 1 : 0;
  const drawActual = actual === "D" ? 1 : 0;
  const awayActual = actual === "A" ? 1 : 0;

  return (
    Math.pow(probabilities.home - homeActual, 2) +
    Math.pow(probabilities.draw - drawActual, 2) +
    Math.pow(probabilities.away - awayActual, 2)
  );
}

function logLoss(probabilities, actual) {
  let p;

  if (actual === "H") p = probabilities.home;
  else if (actual === "D") p = probabilities.draw;
  else p = probabilities.away;

  return -Math.log(
    Math.max(0.000001, p)
  );
}

function accuracy(probabilities, actual) {
  const entries = [
    ["H", probabilities.home],
    ["D", probabilities.draw],
    ["A", probabilities.away]
  ];

  entries.sort((a, b) => b[1] - a[1]);

  return entries[0][0] === actual ? 1 : 0;
}

async function getStoredMatches() {
  const url =
    `${BBS_BASE}/v1/stored/matches` +
    `?sport=${SPORT}` +
    `&league=${LEAGUE}` +
    `&status=finished` +
    `&limit=200`;

  const payload = await fetchJson(
    url,
    STORED_TIMEOUT
  );

  return extractMatches(payload)
    .filter(isFinished)
    .sort((a, b) => {
      const da = getMatchDate(a)?.getTime() || 0;
      const db = getMatchDate(b)?.getTime() || 0;
      return db - da;
    });
}

async function getMatchStats(match) {
  const id =
    match?.id ||
    match?.match_id ||
    match?.matchId;

  if (!id) {
    return null;
  }

  const url =
    `${BBS_BASE}/v1/stored/matches/${id}/stats`;

  try {
    const payload = await fetchJson(
      url,
      STATS_TIMEOUT
    );

    return extractXG(payload);
  } catch (error) {
    return {
      error: error?.message || "stats error"
    };
  }
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Usa GET per /api/backtest."
    });
  }

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
      message: "BBS_API_KEY non configurata."
    });
  }

  try {
    const requested = Number(
      req.query?.matches ||
      DEFAULT_MATCHES
    );

    const limit = Math.min(
      Math.max(
        Number.isFinite(requested)
          ? requested
          : DEFAULT_MATCHES,
        10
      ),
      MAX_MATCHES
    );

    const storedMatches =
      await getStoredMatches();

    const selected =
      storedMatches.slice(0, limit);

    /*
     * Recuperiamo gli xG delle partite selezionate.
     *
     * Con 40 partite restiamo ben sotto il
     * limite di 100 richieste/minuto.
     */
    const statsResults = [];

    for (const match of selected) {
      const stats =
        await getMatchStats(match);

      statsResults.push({
        match,
        stats
      });
    }

    /*
     * Creiamo una mappa xG per partita.
     */
    const xgByMatch = new Map();

    for (const item of statsResults) {
      const id =
        item.match?.id ||
        item.match?.match_id ||
        item.match?.matchId;

      if (id && item.stats?.home !== undefined) {
        xgByMatch.set(
          String(id),
          item.stats
        );
      }
    }

    /*
     * Calcoliamo medie xG storiche per squadra
     * usando SOLO partite precedenti.
     */
    const historicalXG = {};

    for (const item of statsResults) {
      const match = item.match;
      const xg = item.stats;

      const date = getMatchDate(match);

      if (
        !date ||
        !xg ||
        xg.home === undefined ||
        xg.away === undefined
      ) {
        continue;
      }

      const home = normalizeName(
        getHomeTeam(match)
      );

      const away = normalizeName(
        getAwayTeam(match)
      );

      if (!historicalXG[home]) {
        historicalXG[home] = {
          for: [],
          against: []
        };
      }

      if (!historicalXG[away]) {
        historicalXG[away] = {
          for: [],
          against: []
        };
      }

      historicalXG[home].for.push({
        date,
        value: xg.home
      });

      historicalXG[home].against.push({
        date,
        value: xg.away
      });

      historicalXG[away].for.push({
        date,
        value: xg.away
      });

      historicalXG[away].against.push({
        date,
        value: xg.home
      });
    }

    const results = [];

    let baselineCorrect = 0;
    let xgCorrect = 0;

    let baselineBrier = 0;
    let xgBrier = 0;

    let baselineLogLoss = 0;
    let xgLogLoss = 0;

    let matchesWithXG = 0;

    for (const item of statsResults) {
      const match = item.match;
      const score = getScore(match);
      const date = getMatchDate(match);

      if (!score || !date) {
        continue;
      }

      const homeTeam = getHomeTeam(match);
      const awayTeam = getAwayTeam(match);

      if (!homeTeam || !awayTeam) {
        continue;
      }

      const actual =
        resultClass(score);

      /*
       * IMPORTANTISSIMO:
       *
       * ricostruiamo lo storico solo fino
       * al momento della partita.
       */
      const history =
        buildPreMatchHistory(
          storedMatches,
          date
        );

      const homeStats =
        getTeamStats(
          history,
          homeTeam
        );

      const awayStats =
        getTeamStats(
          history,
          awayTeam
        );

      const baselineXG =
        calculateBaseXG(
          homeStats,
          awayStats
        );

      const baselineMatrix =
        buildMatrix(
          baselineXG.home,
          baselineXG.away
        );

      const baselineProb =
        probabilitiesFromMatrix(
          baselineMatrix
        );

      /*
       * xG rolling history.
       */
      const homeKey =
        normalizeName(homeTeam);

      const awayKey =
        normalizeName(awayTeam);

      const homeXGHistory =
        (historicalXG[homeKey]?.for || [])
          .filter(row => row.date < date)
          .sort((a, b) => b.date - a.date)
          .slice(0, 5);

      const awayXGHistory =
        (historicalXG[awayKey]?.for || [])
          .filter(row => row.date < date)
          .sort((a, b) => b.date - a.date)
          .slice(0, 5);

      const homeRecentXG =
        homeXGHistory.length
          ? homeXGHistory.reduce(
              (sum, row) => sum + row.value,
              0
            ) / homeXGHistory.length
          : null;

      const awayRecentXG =
        awayXGHistory.length
          ? awayXGHistory.reduce(
              (sum, row) => sum + row.value,
              0
            ) / awayXGHistory.length
          : null;

      const xgModel =
        calculateXGModel(
          baselineXG,
          {
            homeFor: homeRecentXG,
            awayFor: awayRecentXG
          }
        );

      const xgMatrix =
        buildMatrix(
          xgModel.home,
          xgModel.away
        );

      const xgProb =
        probabilitiesFromMatrix(
          xgMatrix
        );

      const actualXG =
        item.stats &&
        item.stats.home !== undefined &&
        item.stats.away !== undefined
          ? {
              home: item.stats.home,
              away: item.stats.away
            }
          : null;

      if (actualXG) {
        matchesWithXG++;
      }

      const baselineWasCorrect =
        accuracy(
          baselineProb,
          actual
        );

      const xgWasCorrect =
        accuracy(
          xgProb,
          actual
        );

      baselineCorrect +=
        baselineWasCorrect;

      xgCorrect +=
        xgWasCorrect;

      baselineBrier +=
        brierScore(
          baselineProb,
          actual
        );

      xgBrier +=
        brierScore(
          xgProb,
          actual
        );

      baselineLogLoss +=
        logLoss(
          baselineProb,
          actual
        );

      xgLogLoss +=
        logLoss(
          xgProb,
          actual
        );

      results.push({
        date: date.toISOString(),
        homeTeam,
        awayTeam,
        score: `${score.home}-${score.away}`,
        actual,

        baseline: {
          expectedGoals: {
            home: Number(
              baselineXG.home.toFixed(3)
            ),
            away: Number(
              baselineXG.away.toFixed(3)
            )
          },
          probabilities: baselineProb,
          predicted: [
            ["H", baselineProb.home],
            ["D", baselineProb.draw],
            ["A", baselineProb.away]
          ].sort(
            (a, b) => b[1] - a[1]
          )[0][0]
        },

        withXG: {
          historicalXGAvailable:
            actualXG !== null,
          rollingXG: {
            home:
              homeRecentXG === null
                ? null
                : Number(
                    homeRecentXG.toFixed(3)
                  ),
            away:
              awayRecentXG === null
                ? null
                : Number(
                    awayRecentXG.toFixed(3)
                  )
          },
          expectedGoals: {
            home: Number(
              xgModel.home.toFixed(3)
            ),
            away: Number(
              xgModel.away.toFixed(3)
            )
          },
          probabilities: xgProb,
          predicted: [
            ["H", xgProb.home],
            ["D", xgProb.draw],
            ["A", xgProb.away]
          ].sort(
            (a, b) => b[1] - a[1]
          )[0][0]
        }
      });
    }

    const tested =
      results.length;

    return res.status(200).json({
      ok: true,

      model: {
        baseline:
          "Forma + gol + casa/trasferta + Poisson + Dixon-Coles",

        withXG:
          "Baseline + rolling team xG"
      },

      dataset: {
        requested: limit,
        storedAvailable:
          storedMatches.length,
        tested,
        matchesWithXG
      },

      metrics: {
        baseline: {
          accuracy:
            tested
              ? Number(
                  (
                    baselineCorrect /
                    tested
                  ).toFixed(4)
                )
              : null,

          brierScore:
            tested
              ? Number(
                  (
                    baselineBrier /
                    tested
                  ).toFixed(4)
                )
              : null,

          logLoss:
            tested
              ? Number(
                  (
                    baselineLogLoss /
                    tested
                  ).toFixed(4)
                )
              : null
        },

        withXG: {
          accuracy:
            tested
              ? Number(
                  (
                    xgCorrect /
                    tested
                  ).toFixed(4)
                )
              : null,

          brierScore:
            tested
              ? Number(
                  (
                    xgBrier /
                    tested
                  ).toFixed(4)
                )
              : null,

          logLoss:
            tested
              ? Number(
                  (
                    xgLogLoss /
                    tested
                  ).toFixed(4)
                )
              : null
        }
      },

      improvement: {
        accuracy:
          tested
            ? Number(
                (
                  (
                    xgCorrect -
                    baselineCorrect
                  ) /
                  tested
                ).toFixed(4)
              )
            : null,

        brierScore:
          tested
            ? Number(
                (
                  (
                    baselineBrier -
                    xgBrier
                  ) /
                  tested
                ).toFixed(4)
              )
            : null,

        logLoss:
          tested
            ? Number(
                (
                  (
                    baselineLogLoss -
                    xgLogLoss
                  ) /
                  tested
                ).toFixed(4)
              )
            : null
      },

      results,

      diagnostics: {
        requests:
          1 + results.length,
        storedEndpoint:
          "/v1/stored/matches",
        statsEndpoint:
          "/v1/stored/matches/:id/stats",
        note:
          "Il test usa esclusivamente informazioni disponibili prima della partita per costruire le caratteristiche."
      }
    });

  } catch (error) {
    console.error(
      "BACKTEST ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "BACKTEST_ERROR",
      message:
        error?.message ||
        "Errore interno nel backtesting."
    });
  }
}
