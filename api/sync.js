const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const MATCH_LEAGUE = "seriea";
const XG_LEAGUE = "serie-a";
const SPORT = "football";

const TIMEOUT = 10000;
const MAX_LINEUPS = 6;

function response(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "s-maxage=300, stale-while-revalidate=600"
    }
  });
}

async function bbs(path) {
  if (!API_KEY) {
    throw new Error("BBS_API_KEY non configurata");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(`${BBS_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        "X-API-Key": API_KEY,
        Authorization: `Bearer ${API_KEY}`
      },
      signal: controller.signal
    });

    const text = await res.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const err = new Error(
        `BBS ${res.status}: ${
          typeof data === "string"
            ? data
            : JSON.stringify(data)
        }`
      );

      err.status = res.status;
      err.body = data;

      throw err;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function arr(data, keys = []) {
  if (Array.isArray(data)) return data;

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

function number(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(
    String(value).replace(",", ".")
  );

  return Number.isFinite(n) ? n : null;
}

function normalize(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamName(value) {
  if (!value) return null;

  if (typeof value === "string") {
    return value;
  }

  return (
    value.name ||
    value.team_name ||
    value.teamName ||
    value.short_name ||
    null
  );
}

function playerName(row) {
  return (
    row.player_name ||
    row.playerName ||
    row.player?.name ||
    row.name ||
    null
  );
}

function extractXGRows(data) {
  const result = [];

  function walk(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const team =
      value.team_name ||
      value.teamName ||
      teamName(value.team);

    const xg =
      value.xg ??
      value.XG ??
      value.expected_goals ??
      value.expectedGoals;

    if (team && xg !== undefined) {
      result.push(value);
    }

    for (const key of Object.keys(value)) {
      walk(value[key], depth + 1);
    }
  }

  walk(data);

  return result;
}

function parseXG(row) {
  const team =
    row.team_name ||
    row.teamName ||
    teamName(row.team);

  const xG = number(
    row.xg ??
    row.XG ??
    row.expected_goals ??
    row.expectedGoals
  );

  if (!team || xG === null) {
    return null;
  }

  return {
    player: playerName(row),
    team,
    xG,
    npxG: number(
      row.npxg ??
      row.Npxg ??
      row.non_penalty_xg
    ),
    xA: number(
      row.xa ??
      row.Xa ??
      row.expected_assists
    ),
    matches: number(
      row.matches ??
      row.apps ??
      row.appearances
    ),
    minutes: number(
      row.minutes ??
      row.minutes_played
    ),
    goals: number(row.goals)
  };
}

function buildTeamXG(rows) {
  const teams = {};

  for (const row of rows) {
    const key = normalize(row.team);

    if (!key) continue;

    if (!teams[key]) {
      teams[key] = {
        team: row.team,
        xG: 0,
        npxG: 0,
        xA: 0,
        goals: 0,
        players: 0,
        matches: 0,
        minutes: 0
      };
    }

    teams[key].xG += row.xG || 0;
    teams[key].npxG += row.npxG || 0;
    teams[key].xA += row.xA || 0;
    teams[key].goals += row.goals || 0;
    teams[key].players += 1;
    teams[key].minutes += row.minutes || 0;

    if (
      row.matches !== null &&
      row.matches > teams[key].matches
    ) {
      teams[key].matches = row.matches;
    }
  }

  const output = {};

  for (const key of Object.keys(teams)) {
    const t = teams[key];

    output[t.team] = {
      team: t.team,
      xG: Number(t.xG.toFixed(3)),
      npxG: Number(t.npxG.toFixed(3)),
      xA: Number(t.xA.toFixed(3)),
      goals: Math.round(t.goals),
      players: t.players,
      matches: t.matches,
      minutes: Math.round(t.minutes),

      xGPerMatch:
        t.matches > 0
          ? Number((t.xG / t.matches).toFixed(3))
          : null,

      npxGPerMatch:
        t.matches > 0
          ? Number((t.npxG / t.matches).toFixed(3))
          : null
    };
  }

  return output;
}

function getMatchId(match) {
  return (
    match?.id ||
    match?.match_id ||
    match?.matchId ||
    null
  );
}

function isFuture(match) {
  const status = String(
    match?.status || ""
  ).toLowerCase();

  return (
    status === "scheduled" ||
    status === "upcoming" ||
    status === "not_started"
  );
}

async function getLineups(matches, diagnostics) {
  const upcoming = matches
    .filter(isFuture)
    .slice(0, MAX_LINEUPS);

  const lineups = [];

  for (const match of upcoming) {
    const id = getMatchId(match);

    if (!id) continue;

    try {
      const data = await bbs(
        `/v1/matches/${encodeURIComponent(id)}/lineups`
      );

      diagnostics.requests++;

      lineups.push({
        matchId: id,
        home: teamName(match.home),
        away: teamName(match.away),
        data
      });
    } catch (error) {
      diagnostics.lineupErrors.push({
        matchId: id,
        message: error.message,
        status: error.status || null
      });

      if (error.status === 429) {
        break;
      }
    }
  }

  return lineups;
}

export default async function handler(request) {
  const diagnostics = {
    apiKeyDetected: !!API_KEY,
    requests: 0,
    errors: [],
    lineupErrors: [],
    xGEndpoint:
      `/v1/leagues/${XG_LEAGUE}/xg-leaders?stat=xg&season=2026`
  };

  if (!API_KEY) {
    return response(
      {
        ok: false,
        error:
          "BBS_API_KEY non trovata nelle Environment Variables di Vercel.",
        diagnostics
      },
      500
    );
  }

  try {
    // ============================================================
    // 1. MATCHES
    // ============================================================

    const matchesData = await bbs(
      `/v1/matches?sport=${SPORT}&league=${MATCH_LEAGUE}`
    );

    diagnostics.requests++;

    const matches = arr(matchesData, [
      "matches",
      "fixtures",
      "events"
    ]);

    // ============================================================
    // 2. XG LEADERS
    // ============================================================

    let xGData = null;

    try {
      xGData = await bbs(
        `/v1/leagues/${XG_LEAGUE}/xg-leaders?stat=xg&season=2026`
      );

      diagnostics.requests++;
    } catch (error) {
      diagnostics.errors.push({
        type: "xg",
        message: error.message,
        status: error.status || null,
        body: error.body || null
      });
    }

    const rawRows = xGData
      ? extractXGRows(xGData)
      : [];

    const xGRows = rawRows
      .map(parseXG)
      .filter(Boolean);

    const teamXG = buildTeamXG(xGRows);

    // ============================================================
    // 3. LINEUPS
    // ============================================================

    const lineups = await getLineups(
      matches,
      diagnostics
    );

    // ============================================================
    // 4. STANDINGS
    // ============================================================

    let standings = [];

    try {
      const standingsData = await bbs(
        `/v1/standings?sport=${SPORT}&league=${MATCH_LEAGUE}`
      );

      diagnostics.requests++;

      standings = arr(standingsData, [
        "standings",
        "table",
        "rows"
      ]);
    } catch (error) {
      diagnostics.errors.push({
        type: "standings",
        message: error.message,
        status: error.status || null
      });
    }

    // ============================================================
    // 5. OUTPUT
    // ============================================================

    return response({
      ok: true,

      source: "Big Balls Sports Data",

      league: MATCH_LEAGUE,

      generatedAt:
        new Date().toISOString(),

      coverage: {
        matches: matches.length,

        xG: xGRows.length,

        teamsWithXG:
          Object.keys(teamXG).length,

        lineups: lineups.length,

        standings: standings.length
      },

      matches,

      teamXG,

      lineups,

      standings,

      diagnostics
    });
  } catch (error) {
    return response(
      {
        ok: false,

        error: error.message,

        generatedAt:
          new Date().toISOString(),

        diagnostics: {
          ...diagnostics,

          status: error.status || 500,

          body: error.body || null
        }
      },
      error.status === 429
        ? 429
        : 500
    );
  }
}
