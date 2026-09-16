// api/sync.js

const BBS_BASE = "https://api.bigballsdata.com";
const SPORT = "football";

// IMPORTANTE:
// /v1/matches funziona con "seriea" nel progetto attuale.
// L'endpoint xG leaderboard usa invece il codice documentato "serie-a".
const MATCH_LEAGUE = "seriea";
const XG_LEAGUE = "serie-a";

const TIMEOUT = 12000;

// Limiti volutamente bassi per restare molto sotto il Free tier.
const MAX_LINEUPS = 6;
const XG_LIMIT = 200;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
      ...extraHeaders
    }
  });
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value)
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  if (!normalized) {
    return null;
  }

  const n = Number(normalized);

  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 3) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const factor = 10 ** decimals;

  return Math.round(n * factor) / factor;
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(a\.?s\.?|ac|fc|ssc|us|ss|calcio)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTeam(a, b) {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);

  if (!x || !y) {
    return false;
  }

  if (x === y) {
    return true;
  }

  const aliases = {
    "inter milan": "inter",
    "internazionale": "inter",
    "inter": "inter",

    "como 1907": "como",
    "como": "como",

    "as roma": "roma",
    "roma": "roma",

    "ac milan": "milan",
    "milan": "milan",

    "venezia fc": "venezia",
    "venezia": "venezia"
  };

  return (aliases[x] || x) === (aliases[y] || y);
}

function getMatchId(match) {
  return (
    match?.id ||
    match?.match_id ||
    match?.matchId ||
    null
  );
}

function getTeamName(team) {
  if (!team) {
    return null;
  }

  if (typeof team === "string") {
    return team;
  }

  return (
    team.name ||
    team.team_name ||
    team.teamName ||
    team.short_name ||
    null
  );
}

function getKickoff(match) {
  return (
    match?.kickoff_utc ||
    match?.kickoff ||
    match?.start_time ||
    match?.startTime ||
    null
  );
}

function isScheduled(match) {
  const status = String(match?.status || "").toLowerCase();

  if (
    status.includes("scheduled") ||
    status.includes("upcoming") ||
    status.includes("pre") ||
    status === "not_started"
  ) {
    return true;
  }

  return !match?.score && !match?.home_score && !match?.away_score;
}

function collectArrays(value, result = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return result;
  }

  if (Array.isArray(value)) {
    result.push(value);

    for (const item of value) {
      collectArrays(item, result, depth + 1);
    }

    return result;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      collectArrays(value[key], result, depth + 1);
    }
  }

  return result;
}

function findXGRows(payload) {
  const arrays = collectArrays(payload);
  const rows = [];

  for (const arr of arrays) {
    for (const item of arr) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const hasPlayer =
        item.player_name !== undefined ||
        item.playerName !== undefined ||
        item.name !== undefined;

      const hasTeam =
        item.team_name !== undefined ||
        item.teamName !== undefined ||
        item.team !== undefined;

      const hasXG =
        item.xg !== undefined ||
        item.expected_goals !== undefined ||
        item.expectedGoals !== undefined;

      if (hasPlayer && hasTeam && hasXG) {
        rows.push(item);
      }
    }
  }

  // Elimina duplicati.
  const seen = new Set();

  return rows.filter((row) => {
    const player =
      row.player_name ||
      row.playerName ||
      row.name ||
      "";

    const team =
      row.team_name ||
      row.teamName ||
      getTeamName(row.team) ||
      "";

    const key = `${player}|${team}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

function parseXGRow(row) {
  const player =
    row.player_name ||
    row.playerName ||
    row.name ||
    null;

  const team =
    row.team_name ||
    row.teamName ||
    getTeamName(row.team) ||
    null;

  const xg = toNumber(
    row.xg ??
    row.expected_goals ??
    row.expectedGoals
  );

  const npxg = toNumber(
    row.npxg ??
    row.non_penalty_xg ??
    row.nonPenaltyXG
  );

  const xa = toNumber(
    row.xa ??
    row.expected_assists ??
    row.expectedAssists
  );

  const matches = toNumber(
    row.matches ??
    row.apps ??
    row.appearances
  );

  const minutes = toNumber(
    row.minutes ??
    row.mins
  );

  const goals = toNumber(row.goals);
  const assists = toNumber(row.assists);

  if (!team || xg === null) {
    return null;
  }

  return {
    player,
    team,
    xG: xg,
    npxG,
    xA: xa,
    matches,
    minutes,
    goals,
    assists
  };
}

function buildTeamXG(rows, matches) {
  const byTeam = {};

  for (const row of rows) {
    const team = row.team;

    if (!team) {
      continue;
    }

    const key = normalizeTeamName(team);

    if (!key) {
      continue;
    }

    if (!byTeam[key]) {
      byTeam[key] = {
        team,
        xG: 0,
        npxG: 0,
        xA: 0,
        goals: 0,
        assists: 0,
        players: 0,
        playerRows: [],
        maxPlayerMatches: 0,
        totalMinutes: 0
      };
    }

    byTeam[key].xG += row.xG || 0;
    byTeam[key].npxG += row.npxG || 0;
    byTeam[key].xA += row.xA || 0;
    byTeam[key].goals += row.goals || 0;
    byTeam[key].assists += row.assists || 0;
    byTeam[key].players += 1;

    if (row.matches !== null) {
      byTeam[key].maxPlayerMatches = Math.max(
        byTeam[key].maxPlayerMatches,
        row.matches
      );
    }

    if (row.minutes !== null) {
      byTeam[key].totalMinutes += row.minutes;
    }

    byTeam[key].playerRows.push({
      player: row.player,
      xG: round(row.xG, 3),
      npxG: row.npxG === null ? null : round(row.npxG, 3),
      xA: row.xA === null ? null : round(row.xA, 3),
      matches: row.matches,
      minutes: row.minutes
    });
  }

  const result = {};

  for (const key of Object.keys(byTeam)) {
    const item = byTeam[key];

    // Il numero massimo di presenze di un giocatore regolare
    // è un'approssimazione ragionevole delle partite disputate
    // dalla squadra nel feed xG.
    //
    // Se non disponibile, usiamo le partite già concluse trovate
    // nel feed matches.
    const estimatedMatches =
      item.maxPlayerMatches > 0
        ? item.maxPlayerMatches
        : countFinishedMatchesForTeam(item.team, matches);

    const xGPerMatch =
      estimatedMatches > 0
        ? item.xG / estimatedMatches
        : null;

    const npxGPerMatch =
      estimatedMatches > 0
        ? item.npxG / estimatedMatches
        : null;

    result[item.team] = {
      team: item.team,

      xG: round(item.xG, 3),
      npxG: round(item.npxG, 3),
      xA: round(item.xA, 3),

      goals: Math.round(item.goals),
      assists: Math.round(item.assists),

      players: item.players,
      matches: estimatedMatches,

      xGPerMatch: round(xGPerMatch, 3),
      npxGPerMatch: round(npxGPerMatch, 3),

      playerRows: item.playerRows
        .sort((a, b) => (b.xG || 0) - (a.xG || 0))
        .slice(0, 15)
    };
  }

  return result;
}

function countFinishedMatchesForTeam(teamName, matches) {
  if (!teamName || !Array.isArray(matches)) {
    return 0;
  }

  let count = 0;

  for (const match of matches) {
    const home = getTeamName(match?.home);
    const away = getTeamName(match?.away);

    if (
      sameTeam(teamName, home) ||
      sameTeam(teamName, away)
    ) {
      const status = String(match?.status || "").toLowerCase();

      const finished =
        !!match?.score ||
        status.includes("final") ||
        status.includes("finished") ||
        status === "ft" ||
        status === "completed";

      if (finished) {
        count += 1;
      }
    }
  }

  return count;
}

function buildXGTeamLookup(teamXG) {
  const lookup = {};

  for (const key of Object.keys(teamXG || {})) {
    const item = teamXG[key];

    lookup[key] = item;

    const normalized = normalizeTeamName(item.team);

    if (normalized) {
      lookup[normalized] = item;
    }
  }

  return lookup;
}

function attachXGToMatches(matches, teamXG) {
  const lookup = buildXGTeamLookup(teamXG);

  return matches.map((match) => {
    const homeName = getTeamName(match?.home);
    const awayName = getTeamName(match?.away);

    const homeKey = Object.keys(lookup).find((key) =>
      sameTeam(key, homeName)
    );

    const awayKey = Object.keys(lookup).find((key) =>
      sameTeam(key, awayName)
    );

    const homeXG = homeKey ? lookup[homeKey] : null;
    const awayXG = awayKey ? lookup[awayKey] : null;

    return {
      ...match,

      modelData: {
        xG: {
          home:
            homeXG?.xGPerMatch ??
            homeXG?.xG ??
            null,

          away:
            awayXG?.xGPerMatch ??
            awayXG?.xG ??
            null
        },

        xGSeason: {
          home: homeXG?.xG ?? null,
          away: awayXG?.xG ?? null
        },

        xGPerMatch: {
          home: homeXG?.xGPerMatch ?? null,
          away: awayXG?.xGPerMatch ?? null
        }
      }
    };
  });
}

async function fetchBBS(path, apiKey) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  try {
    const response = await fetch(`${BBS_BASE}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    const text = await response.text();

    let body = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const error = new Error(
        `BBS ${response.status}: ${
          typeof body === "string"
            ? body
            : JSON.stringify(body)
        }`
      );

      error.status = response.status;
      error.body = body;

      const retryAfter = response.headers.get("Retry-After");

      if (retryAfter) {
        error.retryAfter = retryAfter;
      }

      throw error;
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function extractItems(payload, possibleKeys = []) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  for (const key of possibleKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (
    payload.data &&
    typeof payload.data === "object"
  ) {
    for (const key of possibleKeys) {
      if (Array.isArray(payload.data[key])) {
        return payload.data[key];
      }
    }
  }

  return [];
}

async function handler(req) {
  const startedAt = Date.now();

  const apiKey = process.env.BBS_API_KEY;

  const diagnostics = {
    apiKeyDetected: !!apiKey,
    requestCount: 0,
    errors: [],
    xG: {
      endpoint: null,
      rowsFound: 0,
      teamsFound: 0,
      sample: []
    }
  };

  if (!apiKey) {
    return jsonResponse(
      {
        ok: false,
        error: "Missing BBS_API_KEY environment variable.",
        generatedAt: new Date().toISOString(),
        diagnostics
      },
      500
    );
  }

  async function request(path, label) {
    diagnostics.requestCount += 1;

    try {
      return await fetchBBS(path, apiKey);
    } catch (error) {
      diagnostics.errors.push({
        type: label,
        status: error.status || null,
        message: error.message,
        retryAfter: error.retryAfter || null
      });

      throw error;
    }
  }

  try {
    // ============================================================
    // 1. MATCHES
    // ============================================================

    let matchesPayload;

    try {
      matchesPayload = await request(
        `/v1/matches?sport=${encodeURIComponent(
          SPORT
        )}&league=${encodeURIComponent(MATCH_LEAGUE)}`,
        "matches"
      );
    } catch (error) {
      if (error.status === 429) {
        return jsonResponse(
          {
            ok: false,
            error: "BBS rate limit reached while loading matches.",
            generatedAt: new Date().toISOString(),
            diagnostics: {
              ...diagnostics,
              status: 429,
              body: error.body || null
            }
          },
          429
        );
      }

      throw error;
    }

    const matches = extractItems(
      matchesPayload,
      ["matches", "fixtures", "events"]
    );

    // ============================================================
    // 2. XG LEADERBOARD
    //
    // Questo è il punto fondamentale del nuovo sync.
    // BBD documenta:
    //
    // GET /v1/leagues/serie-a/xg-leaders?stat=xg
    //
    // ============================================================

    let xGPayload = null;

    try {
      const xGPath =
        `/v1/leagues/${encodeURIComponent(
          XG_LEAGUE
        )}/xg-leaders?stat=xg&season=2026&limit=${XG_LIMIT}`;

      diagnostics.xG.endpoint = xGPath;

      xGPayload = await request(
        xGPath,
        "xg_leaders"
      );
    } catch (error) {
      // Non facciamo fallire tutto il sync se il solo
      // endpoint xG ha temporaneamente un problema.
      xGPayload = null;
    }

    const rawXGRows = xGPayload
      ? findXGRows(xGPayload)
      : [];

    const parsedXGRows = rawXGRows
      .map(parseXGRow)
      .filter(Boolean);

    diagnostics.xG.rowsFound = parsedXGRows.length;

    diagnostics.xG.sample = parsedXGRows
      .slice(0, 10)
      .map((row) => ({
        player: row.player,
        team: row.team,
        xG: row.xG,
        npxG: row.npxG,
        xA: row.xA,
        matches: row.matches,
        minutes: row.minutes
      }));

    // ============================================================
    // 3. TEAM XG
    // ============================================================

    const teamXG = buildTeamXG(
      parsedXGRows,
      matches
    );

    diagnostics.xG.teamsFound =
      Object.keys(teamXG).length;

    // ============================================================
    // 4. ATTACH XG TO FIXTURES
    // ============================================================

    const enrichedMatches = attachXGToMatches(
      matches,
      teamXG
    );

    // ============================================================
    // 5. STANDINGS
    //
    // Una sola chiamata. Se il feed non risponde,
    // il resto del sync rimane utilizzabile.
    // ============================================================

    let standings = [];
    let standingsError = null;

    try {
      const standingsPayload = await request(
        `/v1/standings?sport=${encodeURIComponent(
          SPORT
        )}&league=${encodeURIComponent(MATCH_LEAGUE)}`,
        "standings"
      );

      standings = extractItems(
        standingsPayload,
        [
          "standings",
          "rows",
          "table"
        ]
      );

      // Alcune risposte possono essere:
      // { standings: [{ rows: [...] }] }
      if (
        standings.length > 0 &&
        standings[0] &&
        Array.isArray(standings[0].rows)
      ) {
        standings = standings.flatMap(
          (group) => group.rows || []
        );
      }
    } catch (error) {
      standingsError = {
        status: error.status || null,
        message: error.message
      };
    }

    // ============================================================
    // 6. LINEUPS
    //
    // Solo per alcune prossime partite per non consumare
    // inutilmente il rate limit.
    // ============================================================

    const futureMatches = matches
      .filter(isScheduled)
      .sort((a, b) => {
        const da = new Date(getKickoff(a) || 0).getTime();
        const db = new Date(getKickoff(b) || 0).getTime();

        return da - db;
      })
      .slice(0, MAX_LINEUPS);

    const lineups = [];
    let lineupsChecked = 0;

    for (const match of futureMatches) {
      const id = getMatchId(match);

      if (!id) {
        continue;
      }

      try {
        const payload = await request(
          `/v1/matches/${encodeURIComponent(
            id
          )}/lineups`,
          "lineup"
        );

        lineupsChecked += 1;

        lineups.push({
          matchId: id,
          home: getTeamName(match.home),
          away: getTeamName(match.away),
          data: payload
        });
      } catch (error) {
        // Non interrompiamo il sync per una singola lineup.
      }
    }

    // ============================================================
    // 7. OUTPUT
    // ============================================================

    const coverage = {
      matches: matches.length,

      xG: parsedXGRows.length,

      directMatchXG: 0,

      teamsWithXG:
        Object.keys(teamXG).length,

      lineups: lineupsChecked,

      standings: standings.length
    };

    // "xG" viene mantenuto come numero di righe giocatore
    // con xG valido. Il dato utile per il predictor è teamXG.
    //
    // Se almeno una squadra ha xG, consideriamo l'xG disponibile.
    const xGAvailable =
      Object.keys(teamXG).length > 0;

    const response = {
      ok: true,

      source: "Big Balls Sports Data",

      league: "seriea",

      generatedAt:
        new Date().toISOString(),

      elapsedMs:
        Date.now() - startedAt,

      coverage: {
        ...coverage,

        xGAvailable
      },

      matches: enrichedMatches,

      teamXG,

      lineups,

      standings,

      diagnostics: {
        ...diagnostics,

        standingsAvailable:
          standings.length > 0,

        standingsError,

        requestCount:
          diagnostics.requestCount,

        cache:
          "5 minutes + stale-while-revalidate 10 minutes"
      }
    };

    return jsonResponse(response);
  } catch (error) {
    const status =
      error.status === 429
        ? 429
        : 500;

    return jsonResponse(
      {
        ok: false,

        error:
          error.message ||
          "Unknown sync error",

        generatedAt:
          new Date().toISOString(),

        diagnostics: {
          ...diagnostics,

          status,

          body:
            error.body || null,

          retryAfter:
            error.retryAfter || null
        }
      },
      status
    );
  }
}

export default async function handler(req) {
  return handler(req);
}
