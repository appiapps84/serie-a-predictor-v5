const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const TIMEOUT = 8000;

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-API-Key": apiKey,
    Accept: "application/json"
  };
}

async function fetchJson(url, apiKey, timeoutMs = TIMEOUT) {
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
      data = { raw: text };
    }

    return {
      status: response.status,
      ok: response.ok,
      data
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractArray(data, keys = []) {
  if (Array.isArray(data)) {
    return data;
  }

  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  return [];
}

export default async function handler(req, res) {
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
      error: "MISSING_BBS_API_KEY"
    });
  }

  try {
    // --------------------------------------------------
    // MATCHES
    // --------------------------------------------------

    const matchesResult = await fetchJson(
      `${BBS_BASE}/v1/matches?sport=${SPORT}&league=${LEAGUE}`,
      apiKey
    );

    if (!matchesResult.ok) {
      return res.status(502).json({
        ok: false,
        error: `BBS_${matchesResult.status}`,
        details: matchesResult.data
      });
    }

    const matches = extractArray(matchesResult.data, [
      "matches",
      "fixtures"
    ]);

    // --------------------------------------------------
    // STANDINGS
    // --------------------------------------------------

    const standingsResult = await fetchJson(
      `${BBS_BASE}/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
      apiKey
    );

    const standings = extractArray(standingsResult.data, [
      "standings",
      "table",
      "rows",
      "teams"
    ]);

    // --------------------------------------------------
    // LINEUP
    // --------------------------------------------------

    let lineups = [];
    let lineupDiagnostic = null;

    const firstMatch = matches[0];

    const firstMatchId =
      firstMatch?.id ||
      firstMatch?.match_id ||
      firstMatch?.fixture_id ||
      null;

    if (firstMatchId) {
      const lineupResult = await fetchJson(
        `${BBS_BASE}/v1/stored/matches/${encodeURIComponent(firstMatchId)}/lineups`,
        apiKey
      );

      const lineupRows = extractArray(lineupResult.data, [
        "lineups",
        "players",
        "home",
        "away"
      ]);

      if (lineupRows.length > 0) {
        lineups.push({
          matchId: firstMatchId,
          data: lineupRows
        });
      }

      lineupDiagnostic = {
        matchId: firstMatchId,
        status: lineupResult.status,
        available:
          lineupResult.data?.meta?.available ??
          lineupResult.data?.meta?.lineups_available ??
          null,

        response: lineupResult.data
      };
    }

    // --------------------------------------------------
    // XG DIRETTAMENTE DALLE PARTITE
    // --------------------------------------------------

    const matchXG = {};

    for (const match of matches) {
      const xg =
        match?.xG ||
        match?.xg ||
        match?.expected_goals ||
        match?.expectedGoals ||
        null;

      if (!xg || typeof xg !== "object") {
        continue;
      }

      const homeXG =
        xg.homeXG ??
        xg.home_xg ??
        xg.home ??
        null;

      const awayXG =
        xg.awayXG ??
        xg.away_xg ??
        xg.away ??
        null;

      if (
        Number.isFinite(Number(homeXG)) &&
        Number.isFinite(Number(awayXG))
      ) {
        const id =
          match?.id ||
          match?.match_id ||
          match?.fixture_id;

        if (id) {
          matchXG[id] = {
            homeXG: Number(homeXG),
            awayXG: Number(awayXG)
          };
        }
      }
    }

    return res.status(200).json({
      ok: true,
      source: "Big Balls Sports Data",
      league: LEAGUE,
      generatedAt: new Date().toISOString(),

      coverage: {
        matches: matches.length,
        xG: Object.keys(matchXG).length,
        teamsWithXG: 0,
        lineups: lineups.length,
        standings: standings.length
      },

      matches,

      teamXG: {},

      lineups,

      standings,

      diagnostics: {
        matches: {
          status: matchesResult.status,
          responseKeys:
            matchesResult.data &&
            typeof matchesResult.data === "object"
              ? Object.keys(matchesResult.data)
              : []
        },

        standings: {
          status: standingsResult.status,
          responseKeys:
            standingsResult.data &&
            typeof standingsResult.data === "object"
              ? Object.keys(standingsResult.data)
              : [],

          raw: standingsResult.data
        },

        lineup: lineupDiagnostic,

        xG: {
          found: Object.keys(matchXG).length
        }
      }
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "SYNC_FAILED",
      message:
        error?.name === "AbortError"
          ? "BBS request timeout"
          : error?.message || String(error)
    });
  }
}
