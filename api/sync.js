import { normalizeTeamName, h2hKey } from "./lib/teams.js";
import { getSupabase } from "./lib/supabase.js";

const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const TIMEOUT = 9000;
const STORED_MATCH_LIMIT = 300;

/* =========================================================
   FETCH HELPERS
========================================================= */

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
      headers: apiKey ? authHeaders(apiKey) : { Accept: "application/json" },
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }

    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   BBD - ESTRAZIONI (difensive: non si sa mai quale campo c'e')
========================================================= */

function extractMatches(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.matches)) return data.matches;
  if (Array.isArray(data?.fixtures)) return data.fixtures;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractStandings(data) {
  // BBD: data.data.standings[0].rows
  const leagues = data?.data?.standings;

  if (!Array.isArray(leagues)) return [];

  for (const block of leagues) {
    if (Array.isArray(block?.rows) && block.rows.length > 0) {
      return block.rows;
    }
  }

  return [];
}

function getTeamName(match, side) {
  if (side === "home") {
    return (
      match?.home?.name ??
      match?.home_team?.name ??
      match?.home_name ??
      match?.homeTeam ??
      match?.teams?.home?.name ??
      ""
    );
  }

  return (
    match?.away?.name ??
    match?.away_team?.name ??
    match?.away_name ??
    match?.awayTeam ??
    match?.teams?.away?.name ??
    ""
  );
}

function getMatchDate(match) {
  return (
    match?.kickoff_utc ??
    match?.kickoffUtc ??
    match?.kickoff ??
    match?.date ??
    match?.start_time ??
    match?.startTime ??
    null
  );
}

function getScore(match) {
  const score = match?.score ?? match?.scores ?? null;
  if (!score) return null;

  const home = Number(
    score.home ?? score.home_score ?? score.homeScore ?? score.home_goals ?? score.full_time?.home
  );
  const away = Number(
    score.away ?? score.away_score ?? score.awayScore ?? score.away_goals ?? score.full_time?.away
  );

  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;

  return { home, away };
}

function getMatchId(match) {
  return match?.id ?? match?.match_id ?? match?.fixture_id ?? null;
}

function isFinished(match) {
  const status = String(match?.status || "").toLowerCase();
  if (["finished", "final", "ft", "completed"].includes(status)) return true;
  return Boolean(getScore(match));
}

/* =========================================================
   UNDERSTAT - xG GRATIS (scraping pagina campionato)
========================================================= */

function understatSeasonYear() {
  // stagione "2025" = 2025/26. A settembre siamo nel nuovo anno di stagione.
  const now = new Date();
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function parseUnderstatJsonVar(html, varName) {
  const re = new RegExp(`var ${varName} = JSON\\.parse\\('(.+?)'\\);`, "s");
  const m = html.match(re);
  if (!m) return null;

  try {
    // Understat escapa gli apici dentro la stringa JSON
    const cleaned = m[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function buildUnderstatStats(datesData) {
  // datesData: oggetto { matchId: { h:{title}, a:{title}, goals:{h,a}, xG:{h,a}, datetime, ... } }
  const stats = {};

  function ensure(team) {
    const key = normalizeTeamName(team);
    if (!key) return null;
    if (!stats[key]) {
      stats[key] = {
        team: String(team).trim(),
        played: 0,
        xgFor: 0,
        xgAgainst: 0,
        scored: 0,
        conceded: 0,
        homePlayed: 0,
        homeXgFor: 0,
        awayPlayed: 0,
        awayXgFor: 0,
        matchesWithXg: 0
      };
    }
    return stats[key];
  }

  const matches = Object.values(datesData || {});

  for (const m of matches) {
    const homeName = m?.h?.title ?? m?.home_team ?? null;
    const awayName = m?.a?.title ?? m?.away_team ?? null;
    const homeGoals = Number(m?.goals?.h ?? m?.goals?.home);
    const awayGoals = Number(m?.goals?.a ?? m?.goals?.away);
    const homeXG = Number(m?.xG?.h ?? m?.xG?.home);
    const awayXG = Number(m?.xG?.a ?? m?.xG?.away);

    if (!homeName || !awayName) continue;
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;

    const home = ensure(homeName);
    const away = ensure(awayName);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.scored += homeGoals;
    home.conceded += awayGoals;
    away.scored += awayGoals;
    away.conceded += homeGoals;
    home.homePlayed += 1;
    away.awayPlayed += 1;

    const hasXG = Number.isFinite(homeXG) && Number.isFinite(awayXG);

    if (hasXG) {
      home.matchesWithXg += 1;
      away.matchesWithXg += 1;
      home.xgFor += homeXG;
      home.xgAgainst += awayXG;
      away.xgFor += awayXG;
      away.xgAgainst += homeXG;
      home.homeXgFor += homeXG;
      away.awayXgFor += awayXG;
    }
  }

  // medie per partita (chiavi che consuma predict.js)
  const result = {};

  for (const [key, t] of Object.entries(stats)) {
    if (t.played === 0) continue;

    result[key] = {
      team: t.team,
      played: t.played,
      xgForPerGame: t.matchesWithXg > 0 ? Number((t.xgFor / t.matchesWithXg).toFixed(3)) : null,
      xgAgainstPerGame: t.matchesWithXg > 0 ? Number((t.xgAgainst / t.matchesWithXg).toFixed(3)) : null,
      scoredPerGame: Number((t.scored / t.played).toFixed(3)),
      concededPerGame: Number((t.conceded / t.played).toFixed(3)),
      homeXgForPerGame: t.homePlayed > 0 ? Number((t.homeXgFor / Math.max(1, t.homePlayed)).toFixed(3)) : null,
      awayXgForPerGame: t.awayPlayed > 0 ? Number((t.awayXgFor / Math.max(1, t.awayPlayed)).toFixed(3)) : null,
      matchesWithXg: t.matchesWithXg
    };
  }

  return result;
}

async function fetchUnderstatStats() {
  const year = understatSeasonYear();
  const url = `https://understat.com/league/Serie_A/${year}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!response.ok) {
      return { available: false, reason: `HTTP ${response.status}`, year, stats: {} };
    }

    const html = await response.text();
    if (!html || html.length < 1000) {
      return { available: false, reason: "Risposta HTML vuota o troppo corta", year, stats: {} };
    }

    const datesData = parseUnderstatJsonVar(html, "datesData");

    if (!datesData) {
      return { available: false, reason: "datesData non trovato nella pagina", year, stats: {} };
    }

    const stats = buildUnderstatStats(datesData);

    return {
      available: Object.keys(stats).length > 0,
      year,
      stats,
      teams: Object.keys(stats).length
    };
  } catch (error) {
    return {
      available: false,
      reason: error?.name === "AbortError" ? "TIMEOUT" : String(error?.message || error),
      year,
      stats: {}
    };
  }
}

/* =========================================================
   FORMA + H2H dallo storico BBD
========================================================= */

function buildFormAndH2H(storedMatches) {
  const history = {};
  const h2h = {};

  function ensure(team) {
    const key = normalizeTeamName(team);
    if (!key) return null;
    if (!history[key]) {
      history[key] = { team: String(team).trim(), matches: [] };
    }
    return history[key];
  }

  for (const match of storedMatches) {
    if (!isFinished(match)) continue;

    const homeName = getTeamName(match, "home");
    const awayName = getTeamName(match, "away");
    const score = getScore(match);

    if (!homeName || !awayName || !score) continue;

    const home = ensure(homeName);
    const away = ensure(awayName);
    if (!home || !away) continue;

    const date = getMatchDate(match);
    const matchId = getMatchId(match);

    home.matches.push({
      matchId, date, homeTeam: homeName, awayTeam: awayName,
      homeGoals: score.home, awayGoals: score.away, venue: "home"
    });

    away.matches.push({
      matchId, date, homeTeam: homeName, awayTeam: awayName,
      homeGoals: score.home, awayGoals: score.away, venue: "away"
    });

    const key = h2hKey(homeName, awayName);
    if (!h2h[key]) h2h[key] = [];
    h2h[key].push({
      matchId, date, homeTeam: homeName, awayTeam: awayName,
      homeGoals: score.home, awayGoals: score.away
    });
  }

  // FORMA: ultime 10, poi sintesi ultime 5
  const form = {};

  for (const [key, team] of Object.entries(history)) {
    team.matches.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    const last10 = team.matches.slice(0, 10);
    const last5 = last10.slice(0, 5);

    const summarize = (list) => {
      let pts = 0, gf = 0, ga = 0;
      const results = [];

      for (const m of list) {
        let r;
        if (m.venue === "home") {
          r = m.homeGoals > m.awayGoals ? "W" : m.homeGoals < m.awayGoals ? "L" : "D";
          gf += m.homeGoals; ga += m.awayGoals;
        } else {
          r = m.awayGoals > m.homeGoals ? "W" : m.awayGoals < m.homeGoals ? "L" : "D";
          gf += m.awayGoals; ga += m.homeGoals;
        }
        results.push(r);
        pts += r === "W" ? 3 : r === "D" ? 1 : 0;
      }

      return {
        results,
        points: pts,
        goalsFor: gf,
        goalsAgainst: ga,
        averageGoalsFor: list.length ? Number((gf / list.length).toFixed(3)) : 0,
        averageGoalsAgainst: list.length ? Number((ga / list.length).toFixed(3)) : 0
      };
    };

    const s10 = summarize(last10);
    const s5 = summarize(last5);

    form[key] = {
      team: team.team,
      last5: s5.results,
      last10: s10.results,
      pointsLast5: s5.points,
      pointsLast10: s10.points,
      averageGoalsFor: s5.averageGoalsFor,
      averageGoalsAgainst: s5.averageGoalsAgainst,
      averageGoalsForLast10: s10.averageGoalsFor,
      averageGoalsAgainstLast10: s10.averageGoalsAgainst
    };
  }

  // H2H: max 5 incontri per coppia
  for (const key of Object.keys(h2h)) {
    h2h[key].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    h2h[key] = h2h[key].slice(0, 5);
  }

  return { form, h2h };
}

/* =========================================================
   SALVATAGGIO RISULTATI SU SUPABASE (batch, non bloccante)
========================================================= */

async function saveResultsToSupabase(storedMatches) {
  const supabase = getSupabase();
  if (!supabase) return { saved: 0, skipped: "no_supabase" };

  const rows = [];

  for (const match of storedMatches) {
    if (!isFinished(match)) continue;

    const matchId = getMatchId(match);
    const homeName = getTeamName(match, "home");
    const awayName = getTeamName(match, "away");
    const score = getScore(match);

    if (!matchId || !homeName || !awayName || !score) continue;

    rows.push({
      match_id: String(matchId),
      home_team: homeName,
      away_team: awayName,
      result_1x2: score.home > score.away ? "1" : score.away > score.home ? "2" : "X",
      goals_home: score.home,
      goals_away: score.away,
      finished_at: getMatchDate(match) ?? new Date().toISOString()
    });
  }

  if (rows.length === 0) return { saved: 0, skipped: "no_rows" };

  // upsert a blocchi di 100 (V5 faceva 200 chiamate singole: lentissimo)
  let saved = 0;

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabase
      .from("results")
      .upsert(chunk, { onConflict: "match_id" });

    if (error) return { saved, error: error.message };
    saved += chunk.length;
  }

  return { saved };
}

/* =========================================================
   HANDLER
========================================================= */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
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

  // =========================================================
  // 1. TUTTE LE FONTI IN PARALLELO (V5 le faceva sequenziali)
  // =========================================================

  const storedUrl =
    `${BBS_BASE}/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}` +
    `&status=finished&limit=${STORED_MATCH_LIMIT}&sort=desc`; // FIX V5: sort=desc

  const [matchesRes, standingsRes, storedRes, understat] = await Promise.allSettled([
    fetchJson(`${BBS_BASE}/v1/matches?sport=${SPORT}&league=${LEAGUE}`, apiKey),
    fetchJson(`${BBS_BASE}/v1/standings?sport=${SPORT}&league=${LEAGUE}`, apiKey),
    fetchJson(storedUrl, apiKey),
    fetchUnderstatStats()
  ]);

  // ---- partite correnti: se fallisce, tutto fallisce
  if (matchesRes.status === "rejected" || !matchesRes.value.ok) {
    const r = matchesRes.status === "rejected" ? null : matchesRes.value;
    return res.status(502).json({
      ok: false,
      error: r ? `BBS_${r.status}` : "BBS_NETWORK_ERROR",
      message: "Big Balls non risponde.",
      details: r?.data ?? String(matchesRes.reason)
    });
  }

  const matches = extractMatches(matchesRes.value.data);

  // ---- classifica (opzionale: se fallisce, il modello va avanti senza)
  const standings =
    standingsRes.status === "fulfilled" && standingsRes.value.ok
      ? extractStandings(standingsRes.value.data)
      : [];

  // ---- storico (opzionale)
  const storedMatches =
    storedRes.status === "fulfilled" && storedRes.value.ok
      ? extractMatches(storedRes.value.data)
      : [];

  const storedDates = storedMatches
    .map(getMatchDate)
    .filter(Boolean)
    .sort();

  // =========================================================
  // 2. FORMA + H2H
  // =========================================================

  const { form, h2h } = buildFormAndH2H(storedMatches);

  // =========================================================
  // 3. XG DIRETTO dalle partite BBD (se il piano li include)
  // =========================================================

  const matchXG = {};

  for (const match of matches) {
    const id = getMatchId(match);
    const xg = match?.xG ?? match?.xg ?? null;

    if (!id || !xg || typeof xg !== "object") continue;

    const home = Number(xg.homeXG ?? xg.home_xg ?? xg.home);
    const away = Number(xg.awayXG ?? xg.away_xg ?? xg.away);

    if (Number.isFinite(home) && Number.isFinite(away) && home >= 0 && away >= 0) {
      matchXG[id] = { homeXG: home, awayXG: away };
    }
  }

  // =========================================================
  // 4. teamXG (compatibilita' frontend: NUMERI, non oggetti)
  //    media xG fatta per partita da Understat
  // =========================================================

  const under = understat.status === "fulfilled" ? understat.value : { available: false, stats: {} };
  const teamXG = {};

  for (const [key, s] of Object.entries(under.stats || {})) {
    if (s.xgForPerGame !== null) {
      teamXG[key] = s.xgForPerGame;
    }
  }

  // =========================================================
  // 5. SALVATAGGIO RISULTATI (non blocca la risposta se lento)
  // =========================================================

  let savedResults = { skipped: true };

  if (storedMatches.length > 0) {
    try {
      savedResults = await Promise.race([
        saveResultsToSupabase(storedMatches),
        new Promise((resolve) => setTimeout(() => resolve({ saved: 0, skipped: "timeout" }), 5000))
      ]);
    } catch (error) {
      savedResults = { saved: 0, error: String(error?.message || error) };
    }
  }

  // =========================================================
  // 6. RISPOSTA (contratto compatibile con V5 + campi nuovi)
  // =========================================================

  return res.status(200).json({
    ok: true,
    source: "Big Balls Sports Data + Understat",
    league: LEAGUE,
    generatedAt: new Date().toISOString(),

    coverage: {
      matches: matches.length,
      storedFinishedMatches: storedMatches.length,
      standings: standings.length,
      teamsWithForm: Object.keys(form).length,
      h2hPairs: Object.keys(h2h).length,
      understatTeams: Object.keys(under.stats || {}).length,
      understatAvailable: Boolean(under.available),
      lineups: 0,
      injuries: 0
    },

    matches,
    storedMatches,
    standings,
    teamXG,                    // { nome_normalizzato: numero } <- FIX bug V5
    understat: under.stats || {},  // dati xG ricchi per il modello
    form,
    h2h,
    lineups: [],
    injuries: [],

    diagnostics: {
      matches: { status: matchesRes.value.status, count: matches.length },
      standings: {
        status: standingsRes.status === "fulfilled" ? standingsRes.value.status : "FAILED",
        available: standings.length > 0
      },
      stored: {
        status: storedRes.status === "fulfilled" ? storedRes.value.status : "FAILED",
        count: storedMatches.length,
        oldestDate: storedDates[0] ?? null,
        newestDate: storedDates[storedDates.length - 1] ?? null
      },
      understat: {
        available: Boolean(under.available),
        year: under.year ?? null,
        teams: under.teams ?? 0,
        note: under.available ? null : (under.reason || "non disponibile")
      },
      supabase: savedResults,
      requests: 3,
      elapsedMs: Date.now() - startedAt
    }
  });
}
