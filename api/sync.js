const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "serie-a";
const SPORT = "football";
const TIMEOUT = 10000;

// Numero massimo di partite per cui proviamo a recuperare
// stats e lineups. Evita di fare troppe chiamate API.
const MAX_DETAIL_MATCHES = 20;

async function bbsFetch(path, key) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

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

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const error = new Error(
        `BBS ${response.status} ${response.statusText}`
      );

      error.status = response.status;
      error.body =
        typeof data === "string"
          ? data.slice(0, 500)
          : JSON.stringify(data).slice(0, 1000);

      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;

  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.matches)) return value.matches;
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.standings)) return value.standings;

  return [];
}

function firstDefined(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function normalizeMatch(raw) {
  const homeTeam = firstDefined(
    raw.homeTeam,
    raw.home_team,
    raw.home?.name,
    raw.teams?.home?.name,
    raw.home
  );

  const awayTeam = firstDefined(
    raw.awayTeam,
    raw.away_team,
    raw.away?.name,
    raw.teams?.away?.name,
    raw.away
  );

  const id = firstDefined(
    raw.id,
    raw.matchId,
    raw.match_id,
    raw.fixtureId,
    raw.fixture_id
  );

  const kickoff = firstDefined(
    raw.kickoff,
    raw.kickoffTime,
    raw.kickoff_time,
    raw.startTime,
    raw.start_time,
    raw.date,
    raw.matchDate,
    raw.match_date,
    raw.utcDate,
    raw.utc_date
  );

  const status = firstDefined(
    raw.status,
    raw.matchStatus,
    raw.match_status,
    raw.fixture?.status?.short,
    raw.fixture?.status?.long
  );

  const matchday = firstDefined(
    raw.matchday,
    raw.matchDay,
    raw.match_day,
    raw.round,
    raw.week
  );

  const homeScore = firstDefined(
    raw.homeScore,
    raw.home_score,
    raw.score?.home,
    raw.scores?.home,
    raw.result?.home
  );

  const awayScore = firstDefined(
    raw.awayScore,
    raw.away_score,
    raw.score?.away,
    raw.scores?.away,
    raw.result?.away
  );

  return {
    id: id ?? null,
    homeTeam: homeTeam ?? null,
    awayTeam: awayTeam ?? null,
    kickoff: kickoff ?? null,
    status: status ?? "scheduled",
    matchday: matchday ?? null,
    homeScore: homeScore ?? null,
    awayScore: awayScore ?? null,
    xG: null,
    lineups: null,
  };
}

function extractXG(value) {
  if (!value || typeof value !== "object") return null;

  const candidates = [
    value.xG,
    value.xg,
    value.expectedGoals,
    value.expected_goals,
    value.expectedGoalsHome,
    value.expected_goals_home,
  ];

  // Caso classico:
  // { xG: { home: 1.4, away: 0.8 } }
  if (value.xG && typeof value.xG === "object") {
    const home = firstDefined(
      value.xG.home,
      value.xG.homeXG,
      value.xG.home_xg,
      value.xG.homeExpectedGoals
    );

    const away = firstDefined(
      value.xG.away,
      value.xG.awayXG,
      value.xG.away_xg,
      value.xG.awayExpectedGoals
    );

    if (home != null && away != null) {
      return {
        homeXG: Number(home),
        awayXG: Number(away),
      };
    }
  }

  // Caso:
  // { expectedGoals: { home: ..., away: ... } }
  if (
    value.expectedGoals &&
    typeof value.expectedGoals === "object"
  ) {
    const home = firstDefined(
      value.expectedGoals.home,
      value.expectedGoals.homeXG,
      value.expectedGoals.home_xg
    );

    const away = firstDefined(
      value.expectedGoals.away,
      value.expectedGoals.awayXG,
      value.expectedGoals.away_xg
    );

    if (home != null && away != null) {
      return {
        homeXG: Number(home),
        awayXG: Number(away),
      };
    }
  }

  // Caso root:
  // { homeXG: 1.4, awayXG: 0.8 }
  const homeRoot = firstDefined(
    value.homeXG,
    value.home_xg,
    value.homeExpectedGoals,
    value.home_expected_goals
  );

  const awayRoot = firstDefined(
    value.awayXG,
    value.away_xg,
    value.awayExpectedGoals,
    value.away_expected_goals
  );

  if (homeRoot != null && awayRoot != null) {
    return {
      homeXG: Number(homeRoot),
      awayXG: Number(awayRoot),
    };
  }

  // Caso data wrapper
  if (value.data && typeof value.data === "object") {
    return extractXG(value.data);
  }

  // Caso results/matches
  if (Array.isArray(value.results) && value.results.length) {
    return extractXG(value.results[0]);
  }

  if (Array.isArray(value.matches) && value.matches.length) {
    return extractXG(value.matches[0]);
  }

  // Evitiamo di usare candidati inutilizzati, ma lasciamo
  // la funzione compatibile con possibili formati BBS.
  void candidates;

  return null;
}

function normalizeLineups(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value.lineups)) {
    return value.lineups;
  }

  if (Array.isArray(value.data)) {
    return value.data;
  }

  if (Array.isArray(value.results)) {
    return value.results;
  }

  if (value.data && typeof value.data === "object") {
    return normalizeLineups(value.data);
  }

  return null;
}

function formatError(error) {
  return {
    message: error?.message || "Unknown error",
    status: error?.status || null,
    body: error?.body || null,
  };
}

async function getDetails(matches, key) {
  /*
   * IMPORTANTE:
   * Prima filtravamo obbligatoriamente per kickoff.
   * Il feed /v1/matches che stai ricevendo non sta restituendo
   * kickoff, quindi il filtro produceva 0 partite.
   *
   * Ora usiamo semplicemente le prime MAX_DETAIL_MATCHES
   * partite con un ID valido.
   */

  const candidates = matches
    .filter((match) => match?.id)
    .slice(0, MAX_DETAIL_MATCHES);

  const enriched = [];

  for (const match of candidates) {
    const result = {
      ...match,
      xG: null,
      lineups: null,
      detailErrors: [],
    };

    // -------------------------
    // STATS
    // -------------------------
    try {
      const stats = await bbsFetch(
        `/v1/stored/matches/${encodeURIComponent(match.id)}/stats`,
        key
      );

      const xG = extractXG(stats);

      if (xG) {
        result.xG = xG;
      }
    } catch (error) {
      console.warn(
        "BBS stats error",
        match.id,
        formatError(error)
      );

      result.detailErrors.push({
        type: "stats",
        ...formatError(error),
      });
    }

    // -------------------------
    // LINEUPS
    // -------------------------
    try {
      const lineups = await bbsFetch(
        `/v1/stored/matches/${encodeURIComponent(match.id)}/lineups`,
        key
      );

      result.lineups = normalizeLineups(lineups);
    } catch (error) {
      console.warn(
        "BBS lineups error",
        match.id,
        formatError(error)
      );

      result.detailErrors.push({
        type: "lineups",
        ...formatError(error),
      });
    }

    enriched.push(result);
  }

  return enriched;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  const key = process.env.BBS_API_KEY;

  if (!key) {
    return res.status(500).json({
      ok: false,
      error: "BBS_API_KEY_MISSING",
      message:
        "Vercel non trova la variabile BBS_API_KEY.",
    });
  }

  try {
    // -------------------------
    // MATCHES
    // -------------------------
    const matchesResponse = await bbsFetch(
      `/v1/matches?sport=${encodeURIComponent(
        SPORT
      )}&league=${encodeURIComponent(LEAGUE)}`,
      key
    );

    const rawMatches = arrayFrom(matchesResponse);

    const matches = rawMatches
      .map(normalizeMatch)
      .filter(
        (match) =>
          match.homeTeam &&
          match.awayTeam
      );

    // -------------------------
    // STANDINGS
    // -------------------------
    let standings = [];
    let standingsError = null;

    try {
      const standingsResponse = await bbsFetch(
        `/v1/standings?sport=${encodeURIComponent(
          SPORT
        )}&league=${encodeURIComponent(LEAGUE)}`,
        key
      );

      standings = arrayFrom(standingsResponse);
    } catch (error) {
      standingsError = formatError(error);

      console.warn(
        "BBS standings error",
        standingsError
      );
    }

    // -------------------------
    // DETAILS
    // -------------------------
    const details = await getDetails(
      matches,
      key
    );

    const detailsById = new Map(
      details.map((match) => [
        String(match.id),
        match,
      ])
    );

    const enrichedMatches = matches.map(
      (match) => {
        const detail = detailsById.get(
          String(match.id)
        );

        if (!detail) {
          return match;
        }

        return {
          ...match,
          xG: detail.xG,
          lineups: detail.lineups,
          detailErrors:
            detail.detailErrors || [],
        };
      }
    );

    // -------------------------
    // COVERAGE
    // -------------------------
    const xGCount = enrichedMatches.filter(
      (match) =>
        match.xG &&
        Number.isFinite(
          Number(match.xG.homeXG)
        ) &&
        Number.isFinite(
          Number(match.xG.awayXG)
        )
    ).length;

    const lineupCount = enrichedMatches.filter(
      (match) =>
        Array.isArray(match.lineups) &&
        match.lineups.length > 0
    ).length;

    return res.status(200).json({
      ok: true,
      source: "Big Balls Sports Data",
      league: LEAGUE,
      generatedAt: new Date().toISOString(),

      coverage: {
        matches: enrichedMatches.length,
        detailsAttempted: details.length,
        xG: xGCount,
        lineups: lineupCount,
      },

      diagnostics: {
        apiKeyDetected: true,
        standingsAvailable: standings.length > 0,
        standingsError,
        detailErrors: details
          .filter(
            (match) =>
              Array.isArray(
                match.detailErrors
              ) &&
              match.detailErrors.length > 0
          )
          .slice(0, 10)
          .map((match) => ({
            id: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            errors: match.detailErrors,
          })),
      },

      matches: enrichedMatches,
      standings,
    });
  } catch (error) {
    console.error(
      "BBS sync fatal error:",
      formatError(error)
    );

    return res.status(500).json({
      ok: false,
      error: "BBS_SYNC_FAILED",
      details: formatError(error),
    });
  }
}
