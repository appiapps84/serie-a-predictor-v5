const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const MATCHES_TIMEOUT = 8000;
const STANDINGS_TIMEOUT = 5000;
const LINEUPS_TIMEOUT = 5000;

// Manteniamo basso il numero di richieste.
// Il piano free ha 100 req/min e 1.000 req/giorno. [oai_citation:1‡Big Balls Sports Data](https://bigballsdata.com/soccer-api?utm_source=chatgpt.com)
const MAX_LINEUP_REQUESTS = 6;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
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

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-API-Key": apiKey
  };
}

function getArray(data, possibleKeys = []) {
  if (Array.isArray(data)) return data;

  for (const key of possibleKeys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  return [];
}

function getTeamName(team) {
  if (!team) return null;

  if (typeof team === "string") return team;

  return (
    team.name ||
    team.team_name ||
    team.short_name ||
    team.display_name ||
    null
  );
}

function getMatchTeams(match) {
  const home =
    getTeamName(match?.home) ||
    getTeamName(match?.home_team) ||
    match?.home_name ||
    null;

  const away =
    getTeamName(match?.away) ||
    getTeamName(match?.away_team) ||
    match?.away_name ||
    null;

  return { home, away };
}

function normalizeXG(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 10) return null;

  return n;
}

function extractMatchXG(match) {
  const candidates = [
    match?.xG,
    match?.xg,
    match?.expected_goals,
    match?.expectedGoals,
    match?.stats?.xG,
    match?.stats?.xg
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    const home = normalizeXG(
      candidate.homeXG ??
      candidate.home_xg ??
      candidate.home ??
      candidate.home_expected_goals
    );

    const away = normalizeXG(
      candidate.awayXG ??
      candidate.away_xg ??
      candidate.away ??
      candidate.away_expected_goals
    );

    if (home !== null && away !== null) {
      return {
        homeXG: home,
        awayXG: away
      };
    }
  }

  return null;
}

function extractLineupPlayers(data) {
  const rows = getArray(data, [
    "lineups",
    "players",
    "home",
    "away"
  ]);

  return rows;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");

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
      message: "Variabile BBS_API_KEY non configurata su Vercel."
    });
  }

  const startedAt = Date.now();

  const diagnostics = {
    requests: 0,
    matches: null,
    standings: null,
    lineups: {
      requested: 0,
      successful: 0,
      errors: 0
    }
  };

  try {
    // ---------------------------------------------------------
    // 1. PARTITE
    // ---------------------------------------------------------

    const matchesUrl =
      `${BBS_BASE}/v1/matches` +
      `?sport=${encodeURIComponent(SPORT)}` +
      `&league=${encodeURIComponent(LEAGUE)}`;

    const matchesResult = await fetchJson(
      matchesUrl,
      {
        headers: authHeaders(apiKey)
      },
      MATCHES_TIMEOUT
    );

    diagnostics.requests++;

    diagnostics.matches = {
      status: matchesResult.status
    };

    if (!matchesResult.ok) {
      return res.status(502).json({
        ok: false,
        error: `BBS_${matchesResult.status}`,
        message: "Errore nella richiesta delle partite BBD.",
        diagnostics
      });
    }

    const matches = getArray(matchesResult.data, [
      "matches",
      "fixtures"
    ]);

    // ---------------------------------------------------------
    // 2. XG GIÀ PRESENTE NELLA RISPOSTA MATCHES
    // ---------------------------------------------------------

    const matchXG = {};

    for (const match of matches) {
      const xg = extractMatchXG(match);

      if (!xg) continue;

      const id =
        match?.id ||
        match?.match_id ||
        match?.fixture_id;

      if (id) {
        matchXG[id] = xg;
      }
    }

    // ---------------------------------------------------------
    // 3. CLASSIFICA
    // ---------------------------------------------------------

    let standings = [];

    try {
      const standingsUrl =
        `${BBS_BASE}/v1/standings` +
        `?sport=${encodeURIComponent(SPORT)}` +
        `&league=${encodeURIComponent(LEAGUE)}`;

      const standingsResult = await fetchJson(
        standingsUrl,
        {
          headers: authHeaders(apiKey)
        },
        STANDINGS_TIMEOUT
      );

      diagnostics.requests++;

      diagnostics.standings = {
        status: standingsResult.status
      };

      if (standingsResult.ok) {
        standings = getArray(standingsResult.data, [
          "standings",
          "table"
        ]);
      }
    } catch (error) {
      diagnostics.standings = {
        status: 0,
        error:
          error?.name === "AbortError"
            ? "TIMEOUT"
            : String(error?.message || error)
      };
    }

    // ---------------------------------------------------------
    // 4. LINEUPS
    //
    // Solo poche richieste e solo per le prossime partite.
    // Non facciamo richieste storiche.
    // ---------------------------------------------------------

    const lineups = [];

    const lineupCandidates = matches
      .filter((match) => {
        const id =
          match?.id ||
          match?.match_id ||
          match?.fixture_id;

        return Boolean(id);
      })
      .slice(0, MAX_LINEUP_REQUESTS);

    for (const match of lineupCandidates) {
      const matchId =
        match?.id ||
        match?.match_id ||
        match?.fixture_id;

      const lineupUrl =
        `${BBS_BASE}/v1/stored/matches/` +
        `${encodeURIComponent(matchId)}/lineups`;

      diagnostics.lineups.requested++;

      try {
        const lineupResult = await fetchJson(
          lineupUrl,
          {
            headers: authHeaders(apiKey)
          },
          LINEUPS_TIMEOUT
        );

        diagnostics.requests++;

        if (!lineupResult.ok) {
          diagnostics.lineups.errors++;
          continue;
        }

        const players = extractLineupPlayers(lineupResult.data);

        if (players.length > 0) {
          lineups.push({
            matchId,
            players,
            raw: lineupResult.data
          });

          diagnostics.lineups.successful++;
        }
      } catch {
        diagnostics.lineups.errors++;
      }

      // Piccola pausa per evitare burst inutili.
      await sleep(100);
    }

    // ---------------------------------------------------------
    // 5. TEAM XG
    //
    // Per ora non inventiamo valori.
    // Se BBD fornisce xG direttamente nella partita,
    // il frontend/predict può usarlo.
    // ---------------------------------------------------------

    const teamXG = {};

    for (const match of matches) {
      const id =
        match?.id ||
        match?.match_id ||
        match?.fixture_id;

      const xg = id ? matchXG[id] : null;

      if (!xg) continue;

      const teams = getMatchTeams(match);

      if (teams.home) {
        teamXG[teams.home] = {
          ...(teamXG[teams.home] || {}),
          lastMatchXG: xg.homeXG
        };
      }

      if (teams.away) {
        teamXG[teams.away] = {
          ...(teamXG[teams.away] || {}),
          lastMatchXG: xg.awayXG
        };
      }
    }

    // ---------------------------------------------------------
    // 6. RISPOSTA
    // ---------------------------------------------------------

    const xGCount = Object.keys(matchXG).length;

    return res.status(200).json({
      ok: true,
      source: "Big Balls Sports Data",
      league: LEAGUE,
      generatedAt: new Date().toISOString(),

      coverage: {
        matches: matches.length,
        xG: xGCount,
        teamsWithXG: Object.keys(teamXG).length,
        lineups: lineups.length,
        standings: standings.length
      },

      matches,

      // Rimane compatibile con il frontend esistente.
      teamXG,

      lineups,

      standings,

      diagnostics: {
        ...diagnostics,
        elapsedMs: Date.now() - startedAt
      }
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "SYNC_FAILED",
      message: error?.message || "Errore durante la sincronizzazione.",
      diagnostics: {
        ...diagnostics,
        elapsedMs: Date.now() - startedAt
      }
    });
  }
}
