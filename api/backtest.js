const BBS_BASE = "https://api.bigballsdata.com";

const SPORT = "football";
const LEAGUE = "seriea";

const YEAR = 2025;

const MAX_CANDIDATE_MATCHES = 60;
const MAX_TEST_MATCHES = 30;
const MAX_STATS_REQUESTS = 50;

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
  const apiKey = process.env.BBS_API_KEY;

  if (!apiKey) {
    throw new Error("BBS_API_KEY non configurata.");
  }

  const response = await timeoutFetch(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey
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
  if (Array.isArray(payload)) {
    return payload;
  }

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
    match?.game_date ||
    null;

  if (!value) {
    return null;
  }

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

  if (!score) {
    return null;
  }

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

function getMatchId(match) {
  return String(
    match?.id ||
    match?.match_id ||
    match?.matchId ||
    ""
  ).trim();
}

function normalizeMatch(match) {
  return {
    id: getMatchId(match),
    homeTeam: extractHomeTeam(match),
    awayTeam: extractAwayTeam(match),
    date: extractDate(match),
    score: extractScore(match),
    status:
      match?.status ||
      match?.state ||
      match?.match_status ||
      null,
    xG: null
  };
}

function validFinishedMatch(match) {
  if (!match.id) return false;
  if (!match.homeTeam) return false;
  if (!match.awayTeam) return false;
  if (!match.date) return false;
  if (!match.score) return false;

  return true;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function monthDays(year, month) {
  const days = new Date(
    Date.UTC(year, month + 1, 0)
  ).getUTCDate();

  return days;
}

/*
 * Recupera un mese intero usando il filtro date.
 *
 * Usiamo una richiesta per ogni giorno solo se
 * il filtro date giornaliero è necessario.
 *
 * Inizialmente proviamo il mese tramite start/end
 * solo se BBD lo supporta; altrimenti fallback
 * automatico ai singoli giorni.
 */
async function fetchMonth(year, month) {
  const firstDay =
    `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const lastDay =
    `${year}-${String(month + 1).padStart(2, "0")}-${String(
      monthDays(year, month)
    ).padStart(2, "0")}`;

  /*
   * Tentativo principale:
   * date_from/date_to.
   *
   * Se BBD non li accetta, usiamo il fallback.
   */
  const rangeUrl =
    `${BBS_BASE}/v1/stored/matches` +
    `?sport=${encodeURIComponent(SPORT)}` +
    `&league=${encodeURIComponent(LEAGUE)}` +
    `&status=finished` +
    `&date_from=${encodeURIComponent(firstDay)}` +
    `&date_to=${encodeURIComponent(lastDay)}` +
    `&limit=200`;

  try {
    const payload =
      await fetchJson(
        rangeUrl,
        LIST_TIMEOUT
      );

    const rows =
      extractArray(payload);

    if (rows.length > 0) {
      return rows;
    }
  } catch (error) {
    /*
     * Fallback giornaliero sotto.
     */
  }

  /*
   * Fallback sicuro:
   * date=YYYY-MM-DD è documentato da BBD.
   */
  const result = [];

  const days =
    monthDays(year, month);

  for (
    let day = 1;
    day <= days;
    day++
  ) {
    const date =
      `${year}-${String(month + 1).padStart(2, "0")}-${String(
        day
      ).padStart(2, "0")}`;

    const url =
      `${BBS_BASE}/v1/stored/matches` +
      `?sport=${encodeURIComponent(SPORT)}` +
      `&league=${encodeURIComponent(LEAGUE)}` +
      `&status=finished` +
      `&date=${encodeURIComponent(date)}` +
      `&limit=200`;

    try {
      const payload =
        await fetchJson(
          url,
          LIST_TIMEOUT
        );

      result.push(
        ...extractArray(payload)
      );
    } catch (error) {
      /*
       * Non blocchiamo tutto il mese per
       * un singolo giorno problematico.
       */
    }
  }

  return result;
}

function collectUniqueMatches(rows) {
  const map = new Map();

  for (const raw of rows) {
    const match =
      normalizeMatch(raw);

    if (!validFinishedMatch(match)) {
      continue;
    }

    if (
      match.date.getUTCFullYear() !== YEAR
    ) {
      continue;
    }

    const id = match.id;

    if (!map.has(id)) {
      map.set(id, match);
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
 * Cerca xG nella risposta BBD.
 */
function findNumericXG(value) {
  const n = number(value);

  if (
    n !== null &&
    n >= 0 &&
    n <= 10
  ) {
    return n;
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const candidates = [
      value.xg,
      value.XG,
      value.expected_goals,
      value.expectedGoals,
      value.value
    ];

    for (const candidate of candidates) {
      const parsed =
        number(candidate);

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

function extractMatchXG(
  payload,
  homeTeam,
  awayTeam
) {
  if (!payload) {
    return null;
  }

  const data =
    payload?.data ??
    payload;

  /*
   * Caso diretto.
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
    const parsed =
      findNumericXG(value);

    if (parsed !== null) {
      homeXG = parsed;
      break;
    }
  }

  for (const value of awayCandidates) {
    const parsed =
      findNumericXG(value);

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
   * team_stats.
   */
  const teamStats =
    Array.isArray(data?.team_stats)
      ? data.team_stats
      : Array.isArray(data?.teamStats)
        ? data.teamStats
        : [];

  if (teamStats.length > 0) {
    let homeValue = null;
    let awayValue = null;

    for (const row of teamStats) {
      const teamName =
        extractTeamName(
          row?.team ||
          row?.team_name ||
          row?.teamName ||
          row?.name
        );

      const xg =
        findNumericXG(row?.xg) ??
        findNumericXG(row?.XG) ??
        findNumericXG(
          row?.expected_goals
        ) ??
        findNumericXG(
          row?.expectedGoals
        );

      if (xg === null) {
        continue;
      }

      const normalized =
        normalizeName(teamName);

      if (
        normalized ===
        normalizeName(homeTeam)
      ) {
        homeValue = xg;
      }

      if (
        normalized ===
        normalizeName(awayTeam)
      ) {
        awayValue = xg;
      }
    }

    if (
      homeValue !== null &&
      awayValue !== null
    ) {
      return {
        home: homeValue,
        away: awayValue,
        source: "team_stats"
      };
    }
  }

  return null;
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
        normalizeName(
          match.homeTeam
        ) === wanted ||
        normalizeName(
          match.awayTeam
        ) === wanted
      );
    })
    .sort(
      (a, b) =>
        b.date.getTime() -
        a.date.getTime()
    )
    .slice(0, limit);
}

function getRecentForm(
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
    const home =
      normalizeName(
        match.homeTeam
      ) === wanted;

    const gf =
      home
        ? match.score.home
        : match.score.away;

    const ga =
      home
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

function getRollingTeamXG(
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

  const withXG =
    rows.filter(
      match =>
        match.xG &&
        number(match.xG.home) !== null &&
        number(match.xG.away) !== null
    );

  if (withXG.length === 0) {
    return null;
  }

  const wanted =
    normalizeName(teamName);

  let xGFor = 0;
  let xGAgainst = 0;

  for (const match of withXG) {
    const home =
      normalizeName(
        match.homeTeam
      ) === wanted;

    if (home) {
      xGFor += match.xG.home;
      xGAgainst += match.xG.away;
    } else {
      xGFor += match.xG.away;
      xGAgainst += match.xG.home;
    }
  }

  return {
    matches: withXG.length,
    xGFor:
      xGFor / withXG.length,
    xGAgainst:
      xGAgainst / withXG.length
  };
}

function calculateBaseline(
  homeTeam,
  awayTeam,
  history,
  date
) {
  const homeForm =
    getRecentForm(
      history,
      homeTeam,
      date
    );

  const awayForm =
    getRecentForm(
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

    const homeFormFactor =
      clamp(
        0.90 +
          (homeForm.pointsPerGame / 3) *
            0.15,
        0.90,
        1.05
      );

    const awayFormFactor =
      clamp(
        0.90 +
          (awayForm.pointsPerGame / 3) *
            0.15,
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
    home:
      clamp(
        homeXG,
        0.15,
        4.5
      ),
    away:
      clamp(
        awayXG,
        0.10,
        4.0
      )
  };
}

function calculateWithXG(
  homeTeam,
  awayTeam,
  history,
  date
) {
  const baseline =
    calculateBaseline(
      homeTeam,
      awayTeam,
      history,
      date
    );

  const homeXG =
    getRollingTeamXG(
      history,
      homeTeam,
      date
    );

  const awayXG =
    getRollingTeamXG(
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
      xGAvailable: false,
      xGMatches: 0
    };
  }

  /*
   * Combiniamo:
   *
   * 65% modello gol/forma
   * 35% xG storico
   */
  let homeExpected =
    baseline.home * 0.65 +
    homeXG.xGFor * 0.35;

  let awayExpected =
    baseline.away * 0.65 +
    awayXG.xGFor * 0.35;

  /*
   * Piccolo aggiustamento difensivo.
   */
  const awayDefense =
    clamp(
      awayXG.xGAgainst / 1.20,
      0.80,
      1.20
    );

  const homeDefense =
    clamp(
      homeXG.xGAgainst / 1.20,
      0.80,
      1.20
    );

  homeExpected *=
    0.90 +
    awayDefense * 0.10;

  awayExpected *=
    0.90 +
    homeDefense * 0.10;

  return {
    home:
      clamp(
        homeExpected,
        0.15,
        4.5
      ),

    away:
      clamp(
        awayExpected,
        0.10,
        4.0
      ),

    xGAvailable: true,

    xGMatches:
      Math.min(
        homeXG.matches,
        awayXG.matches
      )
  };
}

function poisson(
  k,
  lambda
) {
  if (
    !Number.isFinite(lambda) ||
    lambda <= 0
  ) {
    return k === 0
      ? 1
      : 0;
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

function dixonColesAdjustment(
  homeGoals,
  awayGoals,
  homeLambda,
  awayLambda
) {
  const rho =
    DIXON_COLES_RHO;

  if (
    homeGoals === 0 &&
    awayGoals === 0
  ) {
    return (
      1 -
      homeLambda *
        awayLambda *
        rho
    );
  }

  if (
    homeGoals === 0 &&
    awayGoals === 1
  ) {
    return (
      1 +
      homeLambda * rho
    );
  }

  if (
    homeGoals === 1 &&
    awayGoals === 0
  ) {
    return (
      1 +
      awayLambda * rho
    );
  }

  if (
    homeGoals === 1 &&
    awayGoals === 1
  ) {
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
      const base =
        poisson(h, homeXG) *
        poisson(a, awayXG);

      const adjustment =
        dixonColesAdjustment(
          h,
          a,
          homeXG,
          awayXG
        );

      const probability =
        Math.max(
          0,
          base * adjustment
        );

      matrix[h][a] =
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
        matrix[h][a] /=
          total;
      }
    }
  }

  return matrix;
}

function probabilitiesFromMatrix(
  matrix
) {
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

function actualClass(
  score
) {
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

function predictedClass(
  probabilities
) {
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

function brierScore(
  probabilities,
  actual
) {
  const target = {
    home:
      actual === "home"
        ? 1
        : 0,

    draw:
      actual === "draw"
        ? 1
        : 0,

    away:
      actual === "away"
        ? 1
        : 0
  };

  return (
    Math.pow(
      probabilities.home -
        target.home,
      2
    ) +
    Math.pow(
      probabilities.draw -
        target.draw,
      2
    ) +
    Math.pow(
      probabilities.away -
        target.away,
      2
    )
  );
}

function logLoss(
  probabilities,
  actual
) {
  const epsilon =
    0.000001;

  return -Math.log(
    Math.max(
      epsilon,
      probabilities[actual]
    )
  );
}

function addMetrics(
  metrics,
  probabilities,
  actual
) {
  metrics.matches++;

  if (
    predictedClass(
      probabilities
    ) === actual
  ) {
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
     * 1. RECUPERO DELLE PARTITE DEL 2025
     * ==========================================
     *
     * Usiamo un giorno alla volta come fallback
     * perché BBD documenta date=YYYY-MM-DD.
     *
     * Per evitare un'enorme quantità di chiamate,
     * facciamo prima il tentativo mensile.
     */

    const rawRows = [];

    const monthDiagnostics = [];

    for (
      let month = 0;
      month < 12;
      month++
    ) {
      const firstDay =
        `${YEAR}-${String(month + 1).padStart(2, "0")}-01`;

      const lastDay =
        `${YEAR}-${String(month + 1).padStart(2, "0")}-${String(
          monthDays(YEAR, month)
        ).padStart(2, "0")}`;

      /*
       * BBD attualmente documenta il filtro
       * date singolo. Proviamo comunque una
       * richiesta mensile; se non funziona,
       * passiamo al giorno per giorno.
       */
      const rangeUrl =
        `${BBS_BASE}/v1/stored/matches` +
        `?sport=${encodeURIComponent(SPORT)}` +
        `&league=${encodeURIComponent(LEAGUE)}` +
        `&status=finished` +
        `&date_from=${encodeURIComponent(firstDay)}` +
        `&date_to=${encodeURIComponent(lastDay)}` +
        `&limit=200`;

      let usedRange = false;

      try {
        const rangePayload =
          await fetchJson(
            rangeUrl,
            LIST_TIMEOUT
          );

        const rangeRows =
          extractArray(
            rangePayload
          );

        /*
         * Verifichiamo che il range abbia
         * effettivamente restituito partite
         * appartenenti al mese richiesto.
         */
        const validRangeRows =
          rangeRows.filter(row => {
            const date =
              extractDate(row);

            return (
              date &&
              date.getUTCFullYear() ===
                YEAR &&
              date.getUTCMonth() ===
                month
            );
          });

        if (
          validRangeRows.length > 0
        ) {
          rawRows.push(
            ...validRangeRows
          );

          usedRange = true;
        }
      } catch (error) {
        /*
         * Fallback giornaliero.
         */
      }

      /*
       * Fallback giornaliero.
       *
       * Non lo facciamo se il range ha funzionato.
       */
      if (!usedRange) {
        const days =
          monthDays(
            YEAR,
            month
          );

        for (
          let day = 1;
          day <= days;
          day++
        ) {
          const date =
            `${YEAR}-${String(month + 1).padStart(2, "0")}-${String(
              day
            ).padStart(2, "0")}`;

          const url =
            `${BBS_BASE}/v1/stored/matches` +
            `?sport=${encodeURIComponent(SPORT)}` +
            `&league=${encodeURIComponent(LEAGUE)}` +
            `&status=finished` +
            `&date=${encodeURIComponent(date)}` +
            `&limit=200`;

          try {
            const payload =
              await fetchJson(
                url,
                LIST_TIMEOUT
              );

            rawRows.push(
              ...extractArray(
                payload
              )
            );
          } catch (error) {
            /*
             * Non blocchiamo il backtest
             * per un singolo giorno.
             */
          }
        }
      }

      monthDiagnostics.push({
        month:
          month + 1,

        range:
          `${firstDay} → ${lastDay}`,

        mode:
          usedRange
            ? "range"
            : "daily"
      });
    }

    const allMatches =
      collectUniqueMatches(
        rawRows
      );

    /*
     * Se abbiamo troppe partite, prendiamo
     * le più recenti perché la copertura xG
     * tende ad essere migliore.
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
     * ==========================================
     * 2. RECUPERO xG
     * ==========================================
     */

    const history = [];

    const statsDiagnostics = [];

    let statsRequests = 0;
    let xGMatches = 0;
    let statsUnavailable = 0;
    let statsErrors = 0;

    /*
     * Le candidate sono già ordinate
     * cronologicamente.
     *
     * Le controlliamo dalla più recente
     * alla più vecchia.
     */
    const statsCandidates =
      [...candidates].reverse();

    for (
      const match of statsCandidates
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
        const payload =
          await fetchJson(
            statsUrl,
            STATS_TIMEOUT
          );

        const available =
          payload?.meta?.available;

        const teamStatsAvailable =
          payload?.meta
            ?.team_stats_available;

        if (
          available === false ||
          teamStatsAvailable === false
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
              payload?.meta
                ?.coverage_note ||
              "Stats non disponibili"
          });

          continue;
        }

        const xG =
          extractMatchXG(
            payload,
            match.homeTeam,
            match.awayTeam
          );

        if (!xG) {
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
              "Stats disponibili ma xG non trovato"
          });

          continue;
        }

        match.xG = {
          home: xG.home,
          away: xG.away
        };

        xGMatches++;

        history.push(match);

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
            xG.home,
          awayXG:
            xG.away,
          source:
            xG.source
        });
      } catch (error) {
        statsErrors++;

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
            error?.message ||
            "Errore stats"
        });
      }
    }

    /*
     * Ordiniamo nuovamente la history.
     */
    history.sort(
      (a, b) =>
        a.date.getTime() -
        b.date.getTime()
    );

    /*
     * ==========================================
     * 3. SELEZIONE TEST
     * ==========================================
     *
     * Usiamo partite con xG.
     *
     * IMPORTANTE:
     * una partita viene testata solo se
     * esistono abbastanza dati xG precedenti
     * per costruire il modello con xG.
     */

    const testMatches = [];

    for (
      const match of allMatches
    ) {
      if (
        testMatches.length >=
        MAX_TEST_MATCHES
      ) {
        break;
      }

      /*
       * La partita target deve avere
       * xG post-match.
       */
      const target =
        history.find(
          item =>
            item.id ===
            match.id
        );

      if (!target) {
        continue;
      }

      /*
       * Devono esistere xG precedenti
       * per entrambe le squadre.
       */
      const homePrevious =
        getRollingTeamXG(
          history,
          match.homeTeam,
          match.date
        );

      const awayPrevious =
        getRollingTeamXG(
          history,
          match.awayTeam,
          match.date
        );

      if (
        !homePrevious ||
        !awayPrevious
      ) {
        continue;
      }

      testMatches.push(
        match
      );
    }

    /*
     * ==========================================
     * 4. METRICHE
     * ==========================================
     */

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
       * SOLO partite precedenti.
       *
       * Questo impedisce leakage.
       */
      const previousMatches =
        allMatches.filter(
          previous =>
            previous.date <
            match.date
        );

      const baseline =
        calculateBaseline(
          match.homeTeam,
          match.awayTeam,
          previousMatches,
          match.date
        );

      const withXG =
        calculateWithXG(
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

      addMetrics(
        baselineMetrics,
        baselineProbabilities,
        actual
      );

      if (
        withXG.xGAvailable
      ) {
        addMetrics(
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

          previousXGMatches:
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
        }
      });
    }

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
     * ==========================================
     * 5. RISPOSTA
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
          "Solo informazioni disponibili prima della partita target"
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

        monthDiagnostics,

        note:
          "Backtest esclusivamente su partite di Serie A nell'anno solare 2025. Le partite senza xG vengono escluse dal modello xG."
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
