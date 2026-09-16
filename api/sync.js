const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const MATCHES_TIMEOUT = 8000;
const STANDINGS_TIMEOUT = 5000;
const STORED_TIMEOUT = 8000;

const STORED_MATCH_LIMIT = 200;

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-API-Key": apiKey,
    Accept: "application/json"
  };
}

async function fetchJson(url, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {
        raw: text
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractMatches(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.matches)) {
    return data.matches;
  }

  if (Array.isArray(data?.fixtures)) {
    return data.fixtures;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  return [];
}

function extractStandings(data) {
  const leagues = data?.data?.standings;

  if (!Array.isArray(leagues)) {
    return [];
  }

  const currentLeague = leagues[0];

  if (!currentLeague) {
    return [];
  }

  if (Array.isArray(currentLeague.rows)) {
    return currentLeague.rows;
  }

  return [];
}

function extractDirectMatchXG(match) {
  const xg =
    match?.xG ??
    match?.xg ??
    match?.expected_goals ??
    match?.expectedGoals ??
    null;

  if (!xg || typeof xg !== "object") {
    return null;
  }

  const home = Number(
    xg.homeXG ??
    xg.home_xg ??
    xg.home ??
    xg.home_expected_goals
  );

  const away = Number(
    xg.awayXG ??
    xg.away_xg ??
    xg.away ??
    xg.away_expected_goals
  );

  if (
    !Number.isFinite(home) ||
    !Number.isFinite(away) ||
    home < 0 ||
    away < 0
  ) {
    return null;
  }

  return {
    homeXG: home,
    awayXG: away
  };
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getTeamName(match, side) {
  if (side === "home") {
    return (
      match?.home?.name ??
      match?.home_team?.name ??
      match?.home_name ??
      match?.homeTeam ??
      ""
    );
  }

  return (
    match?.away?.name ??
    match?.away_team?.name ??
    match?.away_name ??
    match?.awayTeam ??
    ""
  );
}

function getMatchDate(match) {
  return (
    match?.kickoff_utc ??
    match?.kickoffUtc ??
    match?.kickoff ??
    match?.date ??
    match?.start_time ??
    match?.startTime ??
    null
  );
}

function getScore(match) {
  const score = match?.score ?? match?.scores ?? null;

  if (!score) {
    return null;
  }

  let home = null;
  let away = null;

  if (typeof score === "object") {
    home = Number(
      score.home ??
      score.home_score ??
      score.homeScore ??
      score.home_goals ??
      score.full_time?.home
    );

    away = Number(
      score.away ??
      score.away_score ??
      score.awayScore ??
      score.away_goals ??
      score.full_time?.away
    );
  }

  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return null;
  }

  return {
    home,
    away
  };
}

function isFinished(match) {
  const status = normalizeName(match?.status);

  if (
    status === "finished" ||
    status === "final" ||
    status === "ft" ||
    status === "completed"
  ) {
    return true;
  }

  return Boolean(getScore(match));
}

function getResultForTeam(match, teamName) {
  const homeName = normalizeName(getTeamName(match, "home"));
  const awayName = normalizeName(getTeamName(match, "away"));
  const wanted = normalizeName(teamName);

  const score = getScore(match);

  if (!score) {
    return null;
  }

  if (homeName === wanted) {
    if (score.home > score.away) return "W";
    if (score.home < score.away) return "L";
    return "D";
  }

  if (awayName === wanted) {
    if (score.away > score.home) return "W";
    if (score.away < score.home) return "L";
    return "D";
  }

  return null;
}

function buildTeamHistory(storedMatches) {
  const history = {};

  function ensure(team) {
    const key = normalizeName(team);

    if (!key) return null;

    if (!history[key]) {
      history[key] = {
        team: team,
        matches: [],
        form: [],
        goalsFor: 0,
        goalsAgainst: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        homeMatches: [],
        awayMatches: []
      };
    }

    return history[key];
  }

  for (const match of storedMatches) {
    if (!isFinished(match)) continue;

    const homeName = getTeamName(match, "home");
    const awayName = getTeamName(match, "away");
    const score = getScore(match);

    if (!homeName || !awayName || !score) continue;

    const date = getMatchDate(match);

    const home = ensure(homeName);
    const away = ensure(awayName);

    if (!home || !away) continue;

    const homeResult =
      score.home > score.away
        ? "W"
        : score.home < score.away
          ? "L"
          : "D";

    const awayResult =
      score.away > score.home
        ? "W"
        : score.away < score.home
          ? "L"
          : "D";

    const base = {
      matchId:
        match?.id ??
        match?.match_id ??
        match?.fixture_id ??
        null,
      date,
      competition:
        match?.competition ??
        match?.league_name ??
        match?.league ??
        LEAGUE,
      homeTeam: homeName,
      awayTeam: awayName,
      homeGoals: score.home,
      awayGoals: score.away
    };

    home.matches.push({
      ...base,
      result: homeResult,
      goalsFor: score.home,
      goalsAgainst: score.away,
      venue: "home"
    });

    away.matches.push({
      ...base,
      result: awayResult,
      goalsFor: score.away,
      goalsAgainst: score.home,
      venue: "away"
    });
  }

  for (const key of Object.keys(history)) {
    const team = history[key];

    team.matches.sort((a, b) => {
      const da = new Date(a.date || 0).getTime();
      const db = new Date(b.date || 0).getTime();
      return db - da;
    });

    const recent = team.matches.slice(0, 10);

    team.form = recent.map(match => match.result);

    team.goalsFor = recent.reduce(
      (sum, match) => sum + match.goalsFor,
      0
    );

    team.goalsAgainst = recent.reduce(
      (sum, match) => sum + match.goalsAgainst,
      0
    );

    team.wins = recent.filter(
      match => match.result === "W"
    ).length;

    team.draws = recent.filter(
      match => match.result === "D"
    ).length;

    team.losses = recent.filter(
      match => match.result === "L"
    ).length;

    team.homeMatches = recent.filter(
      match => match.venue === "home"
    );

    team.awayMatches = recent.filter(
      match => match.venue === "away"
    );
  }

  return history;
}

function buildH2H(storedMatches) {
  const h2h = {};

  for (const match of storedMatches) {
    if (!isFinished(match)) continue;

    const homeName = getTeamName(match, "home");
    const awayName = getTeamName(match, "away");
    const score = getScore(match);

    if (!homeName || !awayName || !score) continue;

    const a = normalizeName(homeName);
    const b = normalizeName(awayName);

    const key =
      a < b
        ? `${a}__${b}`
        : `${b}__${a}`;

    if (!h2h[key]) {
      h2h[key] = [];
    }

    h2h[key].push({
      matchId:
        match?.id ??
        match?.match_id ??
        match?.fixture_id ??
        null,
      date: getMatchDate(match),
      homeTeam: homeName,
      awayTeam: awayName,
      homeGoals: score.home,
      awayGoals: score.away
    });
  }

  for (const key of Object.keys(h2h)) {
    h2h[key].sort((a, b) => {
      const da = new Date(a.date || 0).getTime();
      const db = new Date(b.date || 0).getTime();
      return db - da;
    });

    h2h[key] = h2h[key].slice(0, 10);
  }

  return h2h;
}

function buildFormSummary(teamHistory) {
  const result = {};

  for (const [key, team] of Object.entries(teamHistory)) {
    const matches = team.matches.slice(0, 5);

    const points =
      matches.reduce((sum, match) => {
        if (match.result === "W") return sum + 3;
        if (match.result === "D") return sum + 1;
        return sum;
      }, 0);

    const goalsFor = matches.reduce(
      (sum, match) => sum + match.goalsFor,
      0
    );

    const goalsAgainst = matches.reduce(
      (sum, match) => sum + match.goalsAgainst,
      0
    );

    result[key] = {
      team: team.team,
      last5: matches.map(match => match.result),
      pointsLast5: points,
      goalsForLast5: goalsFor,
      goalsAgainstLast5: goalsAgainst,
      averageGoalsFor:
        matches.length > 0
          ? Number((goalsFor / matches.length).toFixed(3))
          : 0,
      averageGoalsAgainst:
        matches.length > 0
          ? Number((goalsAgainst / matches.length).toFixed(3))
          : 0,
      wins: matches.filter(m => m.result === "W").length,
      draws: matches.filter(m => m.result === "D").length,
      losses: matches.filter(m => m.result === "L").length
    };
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=120, stale-while-revalidate=300"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Usa GET per /api/sync."
    });
  }

  const apiKey = process.env.BBS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_BBS_API_KEY",
      message: "BBS_API_KEY non configurata su Vercel."
    });
  }

  const startedAt = Date.now();

  try {
    // =========================================================
    // 1. PARTITE CORRENTI
    // =========================================================

    const matchesResult = await fetchJson(
      `${BBS_BASE}/v1/matches?sport=${SPORT}&league=${LEAGUE}`,
      apiKey,
      MATCHES_TIMEOUT
    );

    if (!matchesResult.ok) {
      return res.status(502).json({
        ok: false,
        error: `BBS_${matchesResult.status}`,
        message: "Errore BBD durante il recupero delle partite.",
        details: matchesResult.data
      });
    }

    const matches = extractMatches(matchesResult.data);

    // =========================================================
    // 2. CLASSIFICA
    // =========================================================

    let standings = [];

    const standingsDiagnostic = {
      status: null,
      available: false,
      season: null
    };

    try {
      const standingsResult = await fetchJson(
        `${BBS_BASE}/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
        apiKey,
        STANDINGS_TIMEOUT
      );

      standingsDiagnostic.status = standingsResult.status;

      standings = extractStandings(
        standingsResult.data
      );

      const leagueBlock =
        standingsResult.data?.data?.standings?.[0];

      if (leagueBlock) {
        standingsDiagnostic.available =
          standings.length > 0;

        standingsDiagnostic.season =
          leagueBlock.season || null;
      }
    } catch (error) {
      standingsDiagnostic.error =
        error?.name === "AbortError"
          ? "TIMEOUT"
          : String(error?.message || error);
    }

    // =========================================================
    // 3. STORICO PARTITE
    //
    // UNA SOLA CHIAMATA.
    // =========================================================

    let storedMatches = [];

    const storedDiagnostic = {
      status: null,
      count: 0,
      available: false
    };

    try {
      const storedResult = await fetchJson(
        `${BBS_BASE}/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}&status=finished&limit=${STORED_MATCH_LIMIT}`,
        apiKey,
        STORED_TIMEOUT
      );

      storedDiagnostic.status = storedResult.status;

      storedMatches = extractMatches(
        storedResult.data
      );

      storedDiagnostic.count =
        storedMatches.length;

      storedDiagnostic.available =
        storedMatches.length > 0;
    } catch (error) {
      storedDiagnostic.error =
        error?.name === "AbortError"
          ? "TIMEOUT"
          : String(error?.message || error);
    }

    // =========================================================
    // 4. XG DIRETTO DALLE PARTITE
    // =========================================================

    const matchXG = {};

    for (const match of matches) {
      const id =
        match?.id ??
        match?.match_id ??
        match?.fixture_id ??
        null;

      if (!id) continue;

      const xg = extractDirectMatchXG(match);

      if (xg) {
        matchXG[id] = xg;
      }
    }

    // =========================================================
    // 5. TEAM XG
    // =========================================================

    const teamXG = {};

    for (const match of matches) {
      const id =
        match?.id ??
        match?.match_id ??
        match?.fixture_id ??
        null;

      const xg = id
        ? matchXG[id]
        : null;

      if (!xg) continue;

      const homeName =
        match?.home?.name ??
        match?.home_name ??
        null;

      const awayName =
        match?.away?.name ??
        match?.away_name ??
        null;

      if (homeName) {
        teamXG[homeName] = {
          xG: xg.homeXG
        };
      }

      if (awayName) {
        teamXG[awayName] = {
          xG: xg.awayXG
        };
      }
    }

    // =========================================================
    // 6. FORMA RECENTE
    // =========================================================

    const teamHistory =
      buildTeamHistory(storedMatches);

    const form =
      buildFormSummary(teamHistory);

    // =========================================================
    // 7. H2H
    // =========================================================

    const h2h =
      buildH2H(storedMatches);

    // =========================================================
    // 8. RISPOSTA
    // =========================================================

    return res.status(200).json({
      ok: true,

      source: "Big Balls Sports Data",

      league: LEAGUE,

      generatedAt:
        new Date().toISOString(),

      coverage: {
        matches: matches.length,

        storedFinishedMatches:
          storedMatches.length,

        xG:
          Object.keys(matchXG).length,

        teamsWithXG:
          Object.keys(teamXG).length,

        standings:
          standings.length,

        teamsWithForm:
          Object.keys(form).length,

        h2hPairs:
          Object.keys(h2h).length,

        lineups: 0,

        injuries: 0
      },

      matches,

      storedMatches,

      standings,

      teamXG,

      form,

      h2h,

      lineups: [],

      injuries: [],

      diagnostics: {
        matches: {
          status: matchesResult.status,
          count: matches.length
        },

        standings:
          standingsDiagnostic,

        storedMatches:
          storedDiagnostic,

        xG: {
          matchesWithXG:
            Object.keys(matchXG).length,

          teamsWithXG:
            Object.keys(teamXG).length
        },

        form: {
          teams:
            Object.keys(form).length
        },

        h2h: {
          pairs:
            Object.keys(h2h).length
        },

        requests: 3,

        elapsedMs:
          Date.now() - startedAt
      }
    });

  } catch (error) {
    console.error(
      "SYNC ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,

      error: "SYNC_FAILED",

      message:
        error?.name === "AbortError"
          ? "BBD request timeout"
          : error?.message ||
            String(error),

      elapsedMs:
        Date.now() - startedAt
    });
  }
}
