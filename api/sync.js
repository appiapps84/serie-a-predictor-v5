const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const SPORT = "football";
const LEAGUE = "seriea";

// Timeout volutamente breve.
// La funzione deve sempre rispondere rapidamente.
const TIMEOUT = 6000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function bbsFetch(path) {
  if (!API_KEY) {
    const error = new Error("BBS_API_KEY non configurata");
    error.status = 500;
    throw error;
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  const startedAt = Date.now();

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

    const elapsed = Date.now() - startedAt;

    if (!response.ok) {
      const error = new Error(
        `BBS ${response.status}: ${
          typeof data === "string"
            ? data
            : JSON.stringify(data)
        }`
      );

      error.status = response.status;
      error.body = data;
      error.elapsed = elapsed;

      throw error;
    }

    return {
      data,
      elapsed
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        `Timeout BBS dopo ${TIMEOUT} ms`
      );

      timeoutError.status = 504;
      timeoutError.code = "BBS_TIMEOUT";

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function extractArray(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  const possibleKeys = [
    "matches",
    "fixtures",
    "events",
    "data"
  ];

  for (const key of possibleKeys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  if (
    data.data &&
    typeof data.data === "object"
  ) {
    for (const key of possibleKeys) {
      if (Array.isArray(data.data[key])) {
        return data.data[key];
      }
    }
  }

  return [];
}

export default async function handler(request) {
  const startedAt = Date.now();

  const diagnostics = {
    apiKeyDetected: Boolean(API_KEY),
    endpoint:
      `/v1/matches?sport=${SPORT}&league=${LEAGUE}`,
    requests: 0,
    elapsedMs: 0
  };

  // ------------------------------------------------------------
  // API KEY
  // ------------------------------------------------------------

  if (!API_KEY) {
    return json(
      {
        ok: false,
        error:
          "BBS_API_KEY non configurata su Vercel.",
        diagnostics
      },
      500
    );
  }

  // ------------------------------------------------------------
  // MATCHES
  // ------------------------------------------------------------

  try {
    diagnostics.requests = 1;

    const result = await bbsFetch(
      `/v1/matches?sport=${SPORT}&league=${LEAGUE}`
    );

    const matches = extractArray(result.data);

    diagnostics.elapsedMs =
      Date.now() - startedAt;

    return json({
      ok: true,

      source: "Big Balls Sports Data",

      league: LEAGUE,

      generatedAt:
        new Date().toISOString(),

      coverage: {
        matches: matches.length,
        xG: 0,
        lineups: 0,
        standings: 0
      },

      matches,

      // Lasciamo questi campi presenti
      // per non rompere il frontend.
      teamXG: {},
      lineups: [],
      standings: [],

      diagnostics: {
        ...diagnostics,
        bbsElapsedMs: result.elapsed
      }
    });
  } catch (error) {
    diagnostics.elapsedMs =
      Date.now() - startedAt;

    return json(
      {
        ok: false,

        error:
          error.message ||
          "Errore durante la chiamata a Big Balls Data.",

        generatedAt:
          new Date().toISOString(),

        diagnostics: {
          ...diagnostics,

          status:
            error.status || 500,

          code:
            error.code || null,

          body:
            error.body || null
        }
      },

      error.status === 429
        ? 429
        : error.status === 504
          ? 504
          : 500
    );
  }
}
