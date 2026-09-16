const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const MATCHES_TIMEOUT = 8000;
const STANDINGS_TIMEOUT = 5000;

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
  /*
    BBD restituisce:

    {
      data: {
        standings: [
          {
            league_id: "...",
            league_name: "Serie A",
            season: "2026-27",
            rows: [...]
          }
        ]
      }
    }
  */

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
    // MATCHES
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
    // STANDINGS
    // =========================================================

    let standings = [];
    let standingsDiagnostic = {
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

      standings = extractStandings(standingsResult.data);

      const leagueBlock =
        standingsResult.data?.data?.standings?.[0];

      if (leagueBlock) {
        standingsDiagnostic.available = standings.length > 0;
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
    // XG PRESENTE DIRETTAMENTE NELLE PARTITE
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
    // TEAM XG
    //
    // NON inventiamo xG.
    // Verrà valorizzato quando BBD ce lo fornirà direttamente.
    // =========================================================

    const teamXG = {};

    for (const match of matches) {
      const id =
        match?.id ??
        match?.match_id ??
        match?.fixture_id ??
        null;

      const xg = id ? matchXG[id] : null;

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
    // RISPOSTA
    // =========================================================

    return res.status(200).json({
      ok: true,
      source: "Big Balls Sports Data",
      league: LEAGUE,
      generatedAt: new Date().toISOString(),

      coverage: {
        matches: matches.length,
        xG: Object.keys(matchXG).length,
        teamsWithXG: Object.keys(teamXG).length,

        // Lineups volutamente non interrogate:
        // evitiamo richieste inutili e rate limit.
        lineups: 0,

        standings: standings.length
      },

      matches,

      teamXG,

      lineups: [],

      standings,

      diagnostics: {
        matches: {
          status: matchesResult.status,
          count: matches.length
        },

        standings: standingsDiagnostic,

        xG: {
          matchesWithXG: Object.keys(matchXG).length,
          teamsWithXG: Object.keys(teamXG).length
        },

        elapsedMs: Date.now() - startedAt
      }
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "SYNC_FAILED",
      message:
        error?.name === "AbortError"
          ? "BBD request timeout"
          : error?.message || String(error),

      elapsedMs: Date.now() - startedAt
    });
  }
}
