// Endpoint di diagnostica: risponde SEMPRE 200 con un JSON piccolo.
// Serve a capire QUALE collegamento e' rotto senza leggere risposte enormi.
// NON espone mai la chiave API: solo presente/assente.

const BBS_BASE = "https://api.bigballsdata.com";

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-API-Key": apiKey,
    Accept: "application/json"
  };
}

async function timedFetch(url, headers, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();

    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }

    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - start,
      size: text.length,
      sample: json ? JSON.stringify(json).slice(0, 200) : text.slice(0, 200)
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
      ms: Date.now() - start,
      error: String(error?.message || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const apiKey = process.env.BBS_API_KEY || "";

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    env: {
      BBS_API_KEY: apiKey ? "presente" : "MANCANTE",
      SUPABASE_URL: process.env.SUPABASE_URL ? "presente" : "mancante",
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? "presente" : "mancante",
      VERCEL_URL: process.env.VERCEL_URL || null
    },
    bbs_matches: null,
    bbs_standings: null,
    bbs_stored: null,
    understat: null,
    node: process.version
  };

  // BBD - una chiamata leggera
  if (apiKey) {
    result.bbs_matches = await timedFetch(
      `${BBS_BASE}/v1/matches?sport=football&league=seriea`,
      authHeaders(apiKey)
    );
  }

  // Understat - solo gli header bastano per sapere se siamo bloccati
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const start = Date.now();
    try {
      const r = await fetch("https://understat.com/league/Serie_A/2025", {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html"
        },
        signal: controller.signal
      });
      const text = await r.text();
      result.understat = {
        ok: r.ok,
        status: r.status,
        ms: Date.now() - start,
        size: text.length,
        hasDatesData: text.includes("datesData")
      };
    } catch (error) {
      result.understat = {
        ok: false,
        status: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
        ms: Date.now() - start,
        error: String(error?.message || error)
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return res.status(200).json(result);
}
