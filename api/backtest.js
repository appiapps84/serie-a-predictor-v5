const BBS_BASE = "https://api.bigballsdata.com";

const SPORT = "football";
const LEAGUE = "seriea";

const YEAR = 2025;

// Numero massimo di partite candidate da controllare.
// Non significa che verranno necessariamente usate tutte.
const MAX_CANDIDATE_MATCHES = 80;

// Numero massimo di partite con xG effettivamente utilizzate.
const MAX_TEST_MATCHES = 30;

// Per non avvicinarci troppo al limite BBD.
const MAX_STATS_REQUESTS = 60;

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

function timeoutFetch(url, options = {}, timeout = 8000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timer);
  });
}

async function fetchJson(url, timeout) {
  const response = await timeoutFetch(
    url,
    {
      headers: {
        Authorization: `Bearer ${process.env.BBS_API_KEY}`,
        "X-API-Key": process.env.BBS_API_KEY
      }
    },
    timeout
  );

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
    const message =
      payload?.error?.message ||
      payload?.message ||
      `BBD HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function extractArray(payload) {
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

  return {
    home,
    away
  };
}

function isFinished(match) {
  const status = String(
    match?.status ||
    match?.state ||
    match?.match_status ||
    ""
  ).toLowerCase();

  if (
    status.includes("finished") ||
    status === "ft" ||
    status === "complete" ||
    status === "completed"
  ) {
    return true;
  }

  return extractScore(match) !== null;
}

function getMatchId(match) {
  return String(
    match?.id ||
    match?.match_id ||
    match?.matchId ||
    ""
  ).trim();
}

/*
 * Cerca ricorsivamente campi xG.
 *
 * Supporta strutture tipo:
 *
 * {
 *   home: { xg: 1.4 },
 *   away: { xg: 0.8 }
 * }
 *
 * oppure:
 *
 * {
 *   team_stats: [
 *     { team: ..., xg: 1.4 },
 *     { team: ..., xg: 0.8 }
 *   ]
 * }
 */
function collectXGFields(value, path = "root", output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectXGFields(
        item,
        `${path}[${index}]`,
        output
      );
    });

    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();

    if (
      lower === "xg" ||
      lower === "expected_goals" ||
      lower === "expectedgoals" ||
      lower === "expected_goals_for" ||
      lower === "expected_goals_against" ||
      lower.includes("xg")
    ) {
      output.push({
        path: `${path}.${key}`,
        value: child,
        parent: value
      });
    }

    collectXGFields(
      child,
      `${path}.${key}`,
      output
    );
  }

  return output;
}

function findNumericXG(value) {
  const n = number(value);

  if (n !== null && n >= 0 && n <= 10) {
    return n;
  }

  if (value && typeof value === "object") {
    const candidates = [
      value.xg,
      value.XG,
      value.expected_goals,
      value.expectedGoals,
      value.value
    ];

    for (const candidate of candidates) {
      const parsed = number(candidate);

      if (
        parsed !== null &&
        parsed >= 0 &&
        parsed <= 10
      ) {
        return parsed;
      }
    }
  }

  return null;
}

/*
 * Prova a ricavare xG home/away dagli stats.
 *
 * Questa funzione NON assume una singola struttura BBD.
 */
function extractMatchXG(statsPayload, homeTeam, awayTeam) {
  if (!statsPayload) {
    return null;
  }

  const data = statsPayload?.data ?? statsPayload;

  /*
   * Caso 1:
   * data.home / data.away
   */
  const directHomeCandidates = [
    data?.home?.xg,
    data?.home?.XG,
    data?.home?.expected_goals,
    data?.home?.expectedGoals,
    data?.home_xg,
    data?.homeXG,
    data?.expected_goals_home,
    data?.expectedGoalsHome
  ];

  const directAwayCandidates = [
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

  for (const candidate of directHomeCandidates) {
    const parsed = findNumericXG(candidate);

    if (parsed !== null) {
      homeXG = parsed;
      break;
    }
  }

  for (const candidate of directAwayCandidates) {
    const parsed = findNumericXG(candidate);

    if (parsed !== null) {
      awayXG = parsed;
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
   * Caso 2:
   * team_stats
   */
  const teamStats =
    Array.isArray(data?.team_stats)
      ? data.team_stats
      : Array.isArray(data?.teamStats)
        ? data.teamStats
        : [];

  if (teamStats.length > 0) {
    let homeCandidate = null;
    let awayCandidate = null;

    for (const row of teamStats) {
      const teamName = extractTeamName(
        row?.team ||
        row?.team_name ||
        row?.teamName ||
        row?.name
      );

      const xg =
        findNumericXG(row?.xg) ??
        findNumericXG(row?.XG) ??
        findNumericXG(row?.expected_goals) ??
        findNumericXG(row?.expectedGoals);

      if (xg === null) {
        continue;
      }

      const normalized = normalizeName(teamName);

      if (
        normalized === normalizeName(homeTeam)
      ) {
        homeCandidate = xg;
      }

      if (
        normalized === normalizeName(awayTeam)
      ) {
        awayCandidate = xg;
      }
    }

    if (
      homeCandidate !== null &&
      awayCandidate !== null
    ) {
      return {
        home: homeCandidate,
        away: awayCandidate,
        source: "team_stats"
      };
    }
  }

  /*
   * Caso 3:
   * ricerca generica nei campi xG.
   *
   * Usiamo questa parte solo come fallback.
   */
  const candidates = collectXGFields(data);

  const numeric = [];

  for (const candidate of candidates) {
    const parsed = findNumericXG(candidate.value);

    if (parsed !== null) {
      numeric.push({
        value: parsed,
        path: candidate.path
      });
    }
  }

  /*
   * Evitiamo di associare arbitrariamente due numeri
   * se la struttura non permette di capire quale sia
   * casa e quale trasferta.
   */
  if (numeric.length >= 2) {
    const homeHint = numeric.find(item =>
      item.path.toLowerCase().includes("home")
    );

    const awayHint = numeric.find(item =>
      item.path.toLowerCase().includes("away")
    );

    if (homeHint && awayHint) {
      return {
        home: homeHint.value,
        away: awayHint.value,
        source: "generic_home_away"
      };
    }
  }

  return null;
}

/*
 * Estrae gli xG aggregati dalle partite precedenti.
 */
function getRollingTeamXG(history, teamName, beforeDate) {
  const wanted = normalizeName(teamName);

  const rows = history
    .filter(match => {
      if (!match.date) return false;
      if (match.date >= beforeDate) return false;

      return (
        normalizeName(match.homeTeam) === wanted ||
        normalizeName(match.awayTeam) === wanted
      );
    })
    .sort((a, b) => b.date - a.date);

  const recent = rows.slice(0, 5);

  if (recent.length === 0) {
    return null;
  }

  let totalFor = 0;
  let totalAgainst = 0;
  let count = 0;

  for (const match of recent) {
    if (!match.xG) continue;

    const isHome =
      normalizeName(match.homeTeam) === wanted;

    if (isHome) {
      totalFor += match.xG.home;
      totalAgainst += match.xG.away;
    } else {
      totalFor += match.xG.away;
      totalAgainst += match.xG.home;
    }

    count++;
  }

  if (count === 0) {
    return null;
  }

  return {
    matches: count,
    xGFor: totalFor / count,
    xGAgainst: totalAgainst / count
  };
}

/*
 * Forma basata esclusivamente sui risultati precedenti.
 */
function getRecentForm(history, teamName, beforeDate) {
  const wanted = normalizeName(teamName);

  const rows = history
    .filter(match => {
      if (!match.date) return false;
      if (match.date >= beforeDate) return false;

      return (
        normalizeName(match.homeTeam) === wanted ||
        normalizeName(match.awayTeam) === wanted
      );
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, 5);

  if (rows.length === 0) {
    return null;
  }

  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;

  for (const match of rows) {
    const isHome =
      normalizeName(match.homeTeam) === wanted;

    const gf = isHome
      ? match.score.home
      : match.score.away;

    const ga = isHome
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
    goalsForPerGame: goalsFor / rows.length,
    goalsAgainstPerGame: goalsAgainst / rows.length,
    pointsPerGame: points / rows.length
  };
}

function calculateExpectedGoalsBaseline(
  homeTeam,
  awayTeam,
  history,
  date
) {
  const homeForm = getRecentForm(
    history,
    homeTeam,
    date
  );

  const awayForm = getRecentForm(
    history,
    awayTeam,
    date
  );

  let homeXG = 1.35;
  let awayXG = 1.05;

  if (homeForm && awayForm) {
    homeXG =
      0.65 * homeForm.goalsForPerGame +
      0.35 * awayForm.goalsAgainstPerGame;

    awayXG =
      0.65 * awayForm.goalsForPerGame +
      0.35 * homeForm.goalsAgainstPerGame;

    /*
     * Piccolo correttivo forma.
     */
    const homeFormFactor = clamp(
      0.90 +
      (homeForm.pointsPerGame / 3) * 0.15,
      0.90,
      1.05
    );

    const awayFormFactor = clamp(
      0.90 +
      (awayForm.pointsPerGame / 3) * 0.15,
      0.90,
      1.05
    );

    homeXG *= homeFormFactor;
    awayXG *= awayFormFactor;
  }

  /*
   * Vantaggio casa.
   */
  homeXG *= 1.06;

  return {
    home: clamp(homeXG, 0.15, 4.5),
    away: clamp(awayXG, 0.10, 4.0)
  };
}

/*
 * Modello con xG.
 *
 * Se ci sono xG storici per entrambe le squadre,
 * li fonde con la baseline.
 */
function calculateExpectedGoalsWithXG(
  homeTeam,
  awayTeam,
  history,
  date
) {
  const baseline =
    calculateExpectedGoalsBaseline(
      homeTeam,
      awayTeam,
      history,
      date
    );

  const homeXGHistory =
    getRollingTeamXG(
      history,
      homeTeam,
      date
    );

  const awayXGHistory =
    getRollingTeamXG(
      history,
      awayTeam,
      date
    );

  if (
    !homeXGHistory ||
    !awayXGHistory
  ) {
    return {
      ...baseline,
      xGAvailable: false,
      xGMatches: 0
    };
  }

  /*
   * Non sostituiamo completamente il modello:
   * 65% baseline + 35% xG storico.
   */
  let homeXG =
    baseline.home * 0.65 +
    homeXGHistory.xGFor * 0.35;

  let awayXG =
    baseline.away * 0.65 +
    awayXGHistory.xGFor * 0.35;

  /*
   * Informazione difensiva derivata dall'xG subito.
   */
  homeXG =
    homeXG * 0.85 +
    (
      homeXG * (
        0.90 +
        clamp(
          awayXGHistory.xGAgainst / 1.20,
          0.80,
          1.20
        ) * 0.10
      )
    ) * 0.15;

  awayXG =
    awayXG * 0.85 +
    (
      awayXG * (
        0.90 +
        clamp(
          homeXGHistory.xGAgainst / 1.20,
          0.80,
          1.20
        ) * 0.10
      )
    ) * 0.15;

  return {
    home: clamp(homeXG, 0.15, 4.5),
    away: clamp(awayXG, 0.10, 4.0),
    xGAvailable: true,
    xGMatches:
      Math.min(
        homeXGHistory.matches,
        awayXGHistory.matches
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
  const rho = DIXON_COLES_RHO;

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

  for (
    let homeGoals = 0;
    homeGoals <= MAX_GOALS;
    homeGoals++
  ) {
    matrix[homeGoals] = [];

    for (
      let awayGoals = 0;
      awayGoals <= MAX_GOALS;
      awayGoals++
    ) {
      const base =
        poisson(homeGoals, homeXG) *
        poisson(awayGoals, awayXG);

      const adjustment =
        dixonColesAdjustment(
          homeGoals,
          awayGoals,
          homeXG,
          awayXG
        );

      const probability =
        Math.max(0, base * adjustment);

      matrix[homeGoals][awayGoals] =
        probability;

      total += probability;
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

function actualClass(score) {
  if (score.home > score.away) {
    return "home";
  }

  if (score.home === score.away) {
    return "draw";
  }

  return "away";
}

function brierScore(
  probabilities,
  actual
) {
  const target = {
    home: actual === "home" ? 1 : 0,
    draw: actual === "draw" ? 1 : 0,
    away: actual === "away" ? 1 : 0
  };

  return (
    Math.pow(
      probabilities.home - target.home,
      2
    ) +
    Math.pow(
      probabilities.draw - target.draw,
      2
    ) +
    Math.pow(
      probabilities.away - target.away,
      2
    )
  );
}

function logLoss(
  probabilities,
  actual
) {
  const epsilon = 0.000001;

  const probability =
    probabilities[actual];

  return -Math.log(
    Math.max(
      epsilon,
      probability
    )
  );
}

function predictedClass(probabilities) {
  if (
    probabilities.home >=
      probabilities.draw &&
    probabilities.home >=
      probabilities.away
  ) {
    return "home";
  }

  if (
    probabilities.draw >=
      probabilities.home &&
    probabilities.draw >=
      probabilities.away
  ) {
    return "draw";
  }

  return "away";
}

function updateMetrics(
  metrics,
  probabilities,
  actual
) {
  const predicted =
    predictedClass(probabilities);

  if (predicted === actual) {
    metrics.correct++;
  }

  metrics.brier +=
    brierScore(
      probabilities,
      actual
    );

  metrics.logLoss +=
    logLoss(
      probabilities,
      actual
    );
}

function finalizeMetrics(
  metrics
) {
  if (metrics.matches === 0) {
    return {
      accuracy: null,
      brierScore: null,
      logLoss: null
    };
  }

  return {
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

function extractYear(date) {
  return date.getUTCFullYear();
}

function sortByDateAscending(matches) {
  return matches.sort(
    (a, b) =>
      a.date.getTime() -
      b.date.getTime()
  );
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

  const API_KEY =
    process.env.BBS_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
      message:
        "BBS_API_KEY non configurata."
    });
  }

  try {
    /*
     * ============================
     * 1. CARICAMENTO PARTITE 2025
     * ============================
     */

    const storedUrl =
      `${BBS_BASE}/v1/stored/matches` +
      `?sport=${encodeURIComponent(SPORT)}` +
      `&league=${encodeURIComponent(LEAGUE)}` +
      `&status=finished` +
      `&limit=200`;

    const storedPayload =
      await fetchJson(
        storedUrl,
        LIST_TIMEOUT
      );

    const rawMatches =
      extractArray(
        storedPayload
      );

    const allMatches =
      rawMatches
        .map(match => {
          const date =
            extractDate(match);

          const score =
            extractScore(match);

          return {
            id: getMatchId(match),
            homeTeam:
              extractHomeTeam(match),
            awayTeam:
              extractAwayTeam(match),
            date,
            score,
            status:
              match?.status ||
              match?.state ||
              null,
            xG: null
          };
        })
        .filter(match => {
          if (!match.id) return false;
          if (!match.date) return false;
          if (!match.score) return false;
          if (!match.homeTeam) return false;
          if (!match.awayTeam) return false;

          return (
            extractYear(
              match.date
            ) === YEAR
          );
        });

    /*
     * Ordiniamo cronologicamente.
     */
    sortByDateAscending(
      allMatches
    );

    /*
     * Limitiamo le candidate.
     *
     * Partiamo dalle più recenti del 2025
     * perché la copertura stats tende ad
     * essere migliore sulle partite recenti.
     */
    const candidates =
      allMatches
        .slice(
          Math.max(
            0,
            allMatches.length -
              MAX_CANDIDATE_MATCHES
          )
        );

    /*
     * ============================
     * 2. RECUPERO STATS / xG
     * ============================
     */

    const history = [];

    let statsRequests = 0;
    let xGMatches = 0;
    let statsUnavailable = 0;
    let statsErrors = 0;

    const statsDiagnostics = [];

    /*
     * Facciamo le chiamate in sequenza
     * per non avvicinarci al rate limit.
     */
    for (
      const match of candidates
    ) {
      if (
        statsRequests >=
        MAX_STATS_REQUESTS
      ) {
        break;
      }

      statsRequests++;

      const statsUrl =
        `${BBS_BASE}/v1/stored/matches/` +
        `${encodeURIComponent(match.id)}/stats`;

      try {
        const statsPayload =
          await fetchJson(
            statsUrl,
            STATS_TIMEOUT
          );

        const available =
          statsPayload?.meta?.available;

        if (
          available === false ||
          statsPayload?.meta
            ?.team_stats_available ===
            false
        ) {
          statsUnavailable++;

          statsDiagnostics.push({
            id: match.id,
            home: match.homeTeam,
            away: match.awayTeam,
            date:
              match.date.toISOString(),
            xG: false,
            reason:
              statsPayload?.meta
                ?.coverage_note ||
              "Stats non disponibili"
          });

          continue;
        }

        const xG =
          extractMatchXG(
            statsPayload,
            match.homeTeam,
            match.awayTeam
          );

        if (!xG) {
          statsUnavailable++;

          statsDiagnostics.push({
            id: match.id,
            home: match.homeTeam,
            away: match.awayTeam,
            date:
              match.date.toISOString(),
            xG: false,
            reason:
              "Stats disponibili ma xG non trovato"
          });

          continue;
        }

        match.xG = {
          home: xG.home,
          away: xG.away
        };

        xGMatches++;

        statsDiagnostics.push({
          id: match.id,
          home: match.homeTeam,
          away: match.awayTeam,
          date:
            match.date.toISOString(),
          xG: true,
          homeXG: xG.home,
          awayXG: xG.away,
          source: xG.source
        });

        /*
         * Aggiungiamo alla history solo
         * quando abbiamo xG validi.
         */
        history.push(match);
      } catch (error) {
        statsErrors++;

        statsDiagnostics.push({
          id: match.id,
          home: match.homeTeam,
          away: match.awayTeam,
          date:
            match.date.toISOString(),
          xG: false,
          reason:
            error?.message ||
            "Errore stats"
        });
      }
    }

    /*
     * ============================
     * 3. BACKTEST
     * ============================
     *
     * Per evitare data leakage:
     *
     * - la partita target NON viene usata
     *   per costruire il modello;
     * - gli xG disponibili dopo la partita
     *   non vengono utilizzati;
     * - vengono usati solamente dati con
     *   data < target date.
     */

    const testMatches =
      candidates
        .filter(match =>
          match.xG !== null
        )
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
       * Tutta la history precedente
       * alla partita target.
       */
      const previousMatches =
        allMatches.filter(
          previous =>
            previous.date <
            match.date
        );

      const baseline =
        calculateExpectedGoalsBaseline(
          match.homeTeam,
          match.awayTeam,
          previousMatches,
          match.date
        );

      const withXG =
        calculateExpectedGoalsWithXG(
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
          withXG.home,
          withXG.away
        );

      const baselineProbabilities =
        probabilitiesFromMatrix(
          baselineMatrix
        );

      const xGProbabilities =
        probabilitiesFromMatrix(
          xGMatrix
        );

      const actual =
        actualClass(
          match.score
        );

      baselineMetrics.matches++;

      updateMetrics(
        baselineMetrics,
        baselineProbabilities,
        actual
      );

      /*
       * Il modello xG viene contato
       * solo quando aveva davvero xG
       * pre-partita per entrambe le squadre.
       */
      if (
        withXG.xGAvailable
      ) {
        xGMetrics.matches++;

        updateMetrics(
          xGMetrics,
          xGProbabilities,
          actual
        );
      }

      results.push({
        date:
          match.date.toISOString(),

        home:
          match.homeTeam,

        away:
          match.awayTeam,

        score:
          match.score,

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
            predictedClass(
              baselineProbabilities
            ),

          correct:
            predictedClass(
              baselineProbabilities
            ) === actual
        },

        withXG: {
          xGAvailable:
            withXG.xGAvailable,

          xGMatches:
            withXG.xGMatches,

          expectedGoals: {
            home:
              Number(
                withXG.home.toFixed(3)
              ),
            away:
              Number(
                withXG.away.toFixed(3)
              )
          },

          probabilities:
            xGProbabilities,

          predicted:
            predictedClass(
              xGProbabilities
            ),

          correct:
            predictedClass(
              xGProbabilities
            ) === actual
        },

        actual
      });
    }

    /*
     * ============================
     * 4. METRICHE FINALI
     * ============================
     */

    const baselineFinal =
      finalizeMetrics(
        baselineMetrics
      );

    const xGFinal =
      finalizeMetrics(
        xGMetrics
      );

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
     * ============================
     * 5. RISPOSTA
     * ============================
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
        storedMatches2025:
          allMatches.length,

        candidateMatches:
          candidates.length,

        statsRequests,

        matchesWithXG:
          xGMatches,

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

        maxCandidateMatches:
          MAX_CANDIDATE_MATCHES,

        maxTestMatches:
          MAX_TEST_MATCHES,

        maxStatsRequests:
          MAX_STATS_REQUESTS,

        statsEndpoint:
          "/v1/stored/matches/:id/stats",

        note:
          "Le partite senza stats/xG vengono saltate automaticamente. Il backtest usa esclusivamente partite di Serie A del 2025."
      },

      statsDiagnostics
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
        "Errore durante il backtest.",

      status:
        error?.status || null,

      bbs:
        error?.payload || null
    });
  }
}
