const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const LIST_TIMEOUT = 8000;
const STATS_TIMEOUT = 8000;

function timeoutFetch(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.results)) return payload.results;

  return [];
}

function extractTeamName(team) {
  if (typeof team === "string") return team;

  if (team && typeof team === "object") {
    return (
      team.name ||
      team.team_name ||
      team.teamName ||
      team.short_name ||
      team.shortName ||
      ""
    );
  }

  return "";
}

function findXGCandidates(value, path = "root", output = []) {
  if (value === null || value === undefined) return output;

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();

      if (
        lower === "xg" ||
        lower === "expected_goals" ||
        lower === "expectedgoals" ||
        lower === "expected_goals_home" ||
        lower === "expected_goals_away" ||
        lower.includes("xg")
      ) {
        output.push({
          path: `${path}.${key}`,
          value: child
        });
      }

      findXGCandidates(child, `${path}.${key}`, output);
    }
  }

  return output;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Usa GET per /api/xg-test."
    });
  }

  const API_KEY = process.env.BBS_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
      message: "BBS_API_KEY non configurata."
    });
  }

  try {
    /*
     * Puoi passare:
     * /api/xg-test?matchId=UUID
     *
     * Se non passi matchId, prendiamo una partita finita
     * automaticamente.
     */
    let matchId = String(req.query?.matchId || "").trim();
    let match = null;

    /*
     * 1) Se non abbiamo un ID, prendiamo una partita finita.
     */
    if (!matchId) {
      const listUrl =
        `${BBS_BASE}/v1/stored/matches` +
        `?sport=${encodeURIComponent(SPORT)}` +
        `&league=${encodeURIComponent(LEAGUE)}` +
        `&status=finished` +
        `&limit=1`;

      const listResponse = await timeoutFetch(
        listUrl,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "X-API-Key": API_KEY
          }
        },
        LIST_TIMEOUT
      );

      const listText = await listResponse.text();

      let listPayload;

      try {
        listPayload = JSON.parse(listText);
      } catch {
        return res.status(502).json({
          ok: false,
          error: "INVALID_LIST_JSON",
          status: listResponse.status,
          body: listText.slice(0, 5000)
        });
      }

      if (!listResponse.ok) {
        return res.status(listResponse.status).json({
          ok: false,
          error: "BBS_LIST_ERROR",
          status: listResponse.status,
          body: listPayload
        });
      }

      const matches = extractArray(listPayload);

      match = matches[0] || null;

      if (!match) {
        return res.status(404).json({
          ok: false,
          error: "NO_FINISHED_MATCH",
          message: "Nessuna partita finita trovata."
        });
      }

      matchId = String(match.id || "").trim();

      if (!matchId) {
        return res.status(500).json({
          ok: false,
          error: "MISSING_MATCH_ID",
          message: "La partita restituita da BBD non contiene id.",
          match
        });
      }
    }

    /*
     * 2) Recuperiamo gli stats della partita.
     */
    const statsUrl =
      `${BBS_BASE}/v1/stored/matches/${encodeURIComponent(matchId)}/stats`;

    const statsResponse = await timeoutFetch(
      statsUrl,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "X-API-Key": API_KEY
        }
      },
      STATS_TIMEOUT
    );

    const statsText = await statsResponse.text();

    let statsPayload;

    try {
      statsPayload = JSON.parse(statsText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "INVALID_STATS_JSON",
        matchId,
        status: statsResponse.status,
        body: statsText.slice(0, 10000)
      });
    }

    if (!statsResponse.ok) {
      return res.status(statsResponse.status).json({
        ok: false,
        error: "BBS_STATS_ERROR",
        matchId,
        status: statsResponse.status,
        body: statsPayload
      });
    }

    /*
     * 3) Cerchiamo automaticamente ogni campo
     *    che abbia un nome collegato a xG.
     */
    const xgCandidates = findXGCandidates(statsPayload);

    /*
     * 4) Risposta diagnostica.
     *
     * IMPORTANTE:
     * non restituiamo mai API key o Authorization header.
     */
    return res.status(200).json({
      ok: true,

      match: {
        id: matchId,
        home: extractTeamName(match?.home),
        away: extractTeamName(match?.away),
        kickoff:
          match?.kickoff_utc ||
          match?.kickoff ||
          match?.date ||
          null,
        score: match?.score || null,
        status: match?.status || null
      },

      statsRequest: {
        endpoint: `/v1/stored/matches/:id/stats`,
        status: statsResponse.status
      },

      xgCandidates,

      stats: statsPayload,

      diagnostics: {
        xgCandidatesFound: xgCandidates.length,
        message:
          xgCandidates.length > 0
            ? "Trovati campi collegati a xG. Ora possiamo correggere l'estrattore."
            : "Nessun campo xG trovato nella risposta. Serve verificare la struttura restituita da BBD."
      }
    });
  } catch (error) {
    console.error("XG TEST ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "XG_TEST_ERROR",
      message: error?.message || "Errore durante il test xG."
    });
  }
}
