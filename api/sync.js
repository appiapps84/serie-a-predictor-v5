const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const SPORT = "football";
const LEAGUE = "seriea";

const MATCH_TIMEOUT = 8000;
const OPTIONAL_TIMEOUT = 5000;

function handler(req, res) {
  run(res);
}

async function fetchBBS(path, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${BBS_BASE}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": API_KEY,
        Authorization: `Bearer ${API_KEY}`
      },
      signal: controller.signal
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return {
      status: response.status,
      ok: response.ok,
      data
    };
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        status: 504,
        ok: false,
        timeout: true,
        data: null
      };
    }

    return {
      status: 500,
      ok: false,
      error: error.message,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractArray(data, keys = []) {
  if (Array.isArray(data)) {
    return data;
  }

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

async function run(res) {
  const started = Date.now();

  const diagnostics = {
    apiKeyDetected: Boolean(API_KEY),
    requests: 0,
    matches: {
      status: null,
      elapsedMs: null
    },
    standings: {
      status: null,
      elapsedMs: null
    }
  };

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "BBS_API_KEY non configurata su Vercel.",
      diagnostics
    });
  }

  // ==========================================================
  // 1. MATCHES — OBBLIGATORIO
  // ==========================================================

  const matchStart = Date.now();

  diagnostics.requests++;

  const matchesResult = await fetchBBS(
    `/v1/matches?sport=${SPORT}&league=${LEAGUE}`,
    MATCH_TIMEOUT
  );

  diagnostics.matches.status =
    matchesResult.status;

  diagnostics.matches.elapsedMs =
    Date.now() - matchStart;

  if (!matchesResult.ok) {
    return res.status(
      matchesResult.timeout
        ? 504
        : matchesResult.status || 500
    ).json({
      ok: false,

      error:
        matchesResult.timeout
          ? "Big Balls Data non ha risposto entro 8 secondi."
          : `Errore Big Balls Data HTTP ${matchesResult.status}.`,

      body: matchesResult.data || null,

      diagnostics: {
        ...diagnostics,
        totalElapsedMs: Date.now() - started
      }
    });
  }

  const matches = extractArray(
    matchesResult.data,
    [
      "matches",
      "fixtures",
      "events"
    ]
  );

  // ==========================================================
  // 2. STANDINGS — OPZIONALE
  // ==========================================================

  let standings = [];

  const standingsStart = Date.now();

  diagnostics.requests++;

  const standingsResult = await fetchBBS(
    `/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
    OPTIONAL_TIMEOUT
  );

  diagnostics.standings.status =
    standingsResult.status;

  diagnostics.standings.elapsedMs =
    Date.now() - standingsStart;

  if (standingsResult.ok) {
    standings = extractArray(
      standingsResult.data,
      [
        "standings",
        "table",
        "rows"
      ]
    );
  }

  // ==========================================================
  // 3. OUTPUT
  // ==========================================================

  return res.status(200).json({
    ok: true,

    source: "Big Balls Sports Data",

    league: LEAGUE,

    generatedAt:
      new Date().toISOString(),

    coverage: {
      matches: matches.length,
      xG: 0,
      teamsWithXG: 0,
      lineups: 0,
      standings: standings.length
    },

    matches,

    // Manteniamo questi campi per il frontend.
    teamXG: {},

    lineups: [],

    standings,

    diagnostics: {
      ...diagnostics,
      totalElapsedMs:
        Date.now() - started
    }
  });
}

export default handler;
