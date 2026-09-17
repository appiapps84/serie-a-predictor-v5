import { normalizeTeamName, h2hKey } from "./lib/teams.js";
import { getSupabase } from "./lib/supabase.js";

const BBS_BASE = "https://api.bigballsdata.com";
const LEAGUE = "seriea";
const SPORT = "football";

const TIMEOUT = 9000;
const STORED_MATCH_LIMIT = 300;

/* =========================================================
   MAPPATURA SQUADRE UNDERSTAT
========================================================= */

const UNDERSTAT_TEAM_MAP = {
  fiorentina: "Fiorentina",
  inter: "Inter",
  milan: "Milan",
  juventus: "Juventus",
  napoli: "Napoli",
  lazio: "Lazio",
  roma: "Roma",
  atalanta: "Atalanta",
  torino: "Torino",
  bologna: "Bologna",
  udinese: "Udinese",
  verona: "Hellas_Verona",
  empoli: "Empoli",
  monza: "Monza",
  lecce: "Lecce",
  cagliari: "Cagliari",
  parma: "Parma",
  como: "Como",
  venezia: "Venezia",
  genoa: "Genoa"
};

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
   BBD - ESTRAZIONI (difensive)
========================================================= */

function extractMatches(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.matches)) return data.matches;
  if (Array.isArray(data?.fixtures)) return data.fixtures;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function extractStandings(data) {
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
   UNDERSTAT - SCRAPING ON-DEMAND SINGOLA SQUADRA
========================================================= */

function understatSeasonYear() {
  const now = new Date();
  return now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function fetchSingleTeamXG(teamName, year) {
  const normKey = normalizeTeamName(teamName);
  const understatName = UNDERSTAT_TEAM_MAP[normKey] || teamName;

  const targetUrl = `https://understat.com/team/${encodeURIComponent(understatName)}/${year}`;
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(proxyUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return null;

    const html = await response.text();
    const match = html.match(/datesData\s*=\s*JSON\.parse\('([^']+)'/);

    if (!match) return null;

    const decoded = match[1]
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    const matches = JSON.parse(decoded);

    let xG = 0;
    let xGA = 0;
    let played = 0;

    for (const m of matches) {
      if (!m.isResult) continue;

      const isHome = m.h.title.toLowerCase().includes(understatName.toLowerCase());
      const homeXG = Number(m.xG?.h ?? 0);
      const awayXG = Number(m.xG?.a ?? 0);

      if (isHome) {
        xG += homeXG;
        xGA += awayXG;
      } else {
        xG += awayXG;
        xGA += homeXG;
      }
      played++;
    }

    if (played === 0) return null;

    return {
      team: teamName,
      normKey,
      played,
      xgForPerGame: Number((xG / played).toFixed(3)),
      xgAgainstPerGame: Number((xGA / played).toFixed(3))
    };
  } catch (error) {
    return null;
  }
}

async function fetchOnDemandXG(teamsQuery) {
  const year = understatSeasonYear();
  const teams = teamsQuery.split(",").map((t) => t.trim()).filter(Boolean);

  if (teams.length === 0) return { available: false, stats: {} };

  const results = await Promise.all(teams.map((team) => fetchSingleTeamXG(team, year)));

  const stats = {};
  for (const res of results) {
    if (res && res.normKey) {
      stats[res.normKey] = {
        team: res.team,
        played: res.played,
        xgForPerGame: res.xgForPerGame,
        xgAgainstPerGame: res.xgAgainstPerGame
      };
    }
  }

  return {
    available: Object.keys(stats).length > 0,
    year,
    stats
  };
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

  for (const key of Object.keys(h2h)) {
    h2h[key].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    h2h[key] = h2h[key].slice(0, 5);
  }

  return { form, h2h };
}

/* =========================================================
   SALVATAGGIO SUPABASE
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
   HANDLER PRINCIPALE
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
  const teamsQuery = req.query?.teams ?? null;

  // URL BBD Stored pulito
  const storedUrl = `${BBS_BASE}/v1/stored/matches?sport=${SPORT}&league=${LEAGUE}&limit=${STORED_MATCH_LIMIT}`;

  const [matchesRes, standingsRes, storedRes, understat] = await Promise.allSettled([
    fetchJson(`${BBS_BASE}/v1/matches?sport=${SPORT}&league=${LEAGUE}`, apiKey),
    fetchJson(`${BBS_BASE}/v1/standings?sport=${SPORT}&league=${LEAGUE}`, apiKey),
    fetchJson(storedUrl, apiKey),
    teamsQuery ? fetchOnDemandXG(teamsQuery) : Promise.resolve({ available: false, stats: {} })
  ]);

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

  const standings =
    standingsRes.status === "fulfilled" && standingsRes.value.ok
      ? extractStandings(standingsRes.value.data)
      : [];

  const storedMatches =
    storedRes.status === "fulfilled" && storedRes.value.ok
      ? extractMatches(storedRes.value.data)
      : [];

  const storedDates = storedMatches
    .map(getMatchDate)
    .filter(Boolean)
    .sort();

  const { form, h2h } = buildFormAndH2H(storedMatches);

  const under = understat.status === "fulfilled" ? understat.value : { available: false, stats: {} };
  const teamXG = {};

  for (const [key, s] of Object.entries(under.stats || {})) {
    if (s.xgForPerGame !== null) {
      teamXG[key] = s.xgForPerGame;
    }
  }

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

  return res.status(200).json({
    ok: true,
    source: "Big Balls Sports Data + Understat On-Demand",
    league: LEAGUE,
    generatedAt: new Date().toISOString(),

    coverage: {
      matches: matches.length,
      storedFinishedMatches: storedMatches.length,
      standings: standings.length,
      teamsWithForm: Object.keys(form).length,
      h2hPairs: Object.keys(h2h).length,
      understatTeamsFetched: Object.keys(under.stats || {}).length,
      understatAvailable: Boolean(under.available),
      lineups: 0,
      injuries: 0
    },

    matches,
    storedMatches,
    standings,
    teamXG,
    understat: under.stats || {},
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
        teamsRequested: teamsQuery,
        teamsFetched: Object.keys(under.stats || {}).length
      },
      supabase: savedResults,
      requests: teamsQuery ? 4 : 3,
      elapsedMs: Date.now() - startedAt
    }
  });
}
