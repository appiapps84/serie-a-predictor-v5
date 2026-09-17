import { normalizeTeamName, h2hKey } from "./lib/teams.js";
import { getSupabase } from "./lib/supabase.js";

const MAX_GOALS = 10;
const DIXON_COLES_RHO = -0.08;

// medie di lega Serie A (gol e xG sono molto vicini come scala)
const LEAGUE_HOME_XG = 1.45;
const LEAGUE_AWAY_XG = 1.15;
const LEAGUE_AVG_XG = 1.30;   // media xG per squadra per partita

/* Pesi del modello multi-fattore (rinormalizzati sui fattori disponibili):
   xG Understat 0.35 | classifica 0.25 | forma 0.20 | base 0.20
   Casa/trasferta = moltiplicatore fisso | H2H = aggiustamento +/-5% */
const W = { understat: 0.35, standings: 0.25, form: 0.20, base: 0.20 };

/* =========================================================
   MATH
========================================================= */

function poisson(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;

  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;

  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* =========================================================
   FATTORI
========================================================= */

function getStandingRow(standings, teamName) {
  if (!Array.isArray(standings)) return null;

  const wanted = normalizeTeamName(teamName);

  return standings.find((row) => {
    const candidates = [row?.team_name, row?.teamName, row?.name, row?.team?.name, row?.team?.title];
    return candidates.some((value) => {
      const current = normalizeTeamName(value);
      if (!current || !wanted) return false;
      // match esatto o "contiene" solo se la parte in comune e' lunga >= 4
      // (evita mismatch tipo "roma" dentro "bromley"... con nomi Serie A e' sicuro)
      return current === wanted ||
        (current.includes(wanted) && wanted.length >= 4) ||
        (wanted.includes(current) && current.length >= 4);
    });
  }) || null;
}

function getStandingStats(row) {
  if (!row) return null;

  const games = num(row.games_played ?? row.played ?? row.games ?? row.matches_played);
  const gf = num(row.goals_for ?? row.gf ?? row.goalsFor ?? row.scored);
  const ga = num(row.goals_against ?? row.ga ?? row.goalsAgainst ?? row.conceded);

  if (games === null || games <= 0 || gf === null || ga === null) return null;

  return {
    goalsForPerGame: gf / games,
    goalsAgainstPerGame: ga / games
  };
}

function getFormEntry(form, teamName) {
  if (!form || typeof form !== "object") return null;

  const wanted = normalizeTeamName(teamName);

  if (form[wanted]) return form[wanted];

  for (const [key, value] of Object.entries(form)) {
    if (normalizeTeamName(value?.team) === wanted) return value;
  }

  return null;
}

function getUnderstatEntry(understat, teamName) {
  if (!understat || typeof understat !== "object") return null;

  const wanted = normalizeTeamName(teamName);

  if (understat[wanted]) return understat[wanted];

  for (const [key, value] of Object.entries(understat)) {
    if (normalizeTeamName(value?.team) === wanted) return value;
  }

  return null;
}

function getH2HMatches(h2h, homeTeam, awayTeam) {
  if (!h2h || typeof h2h !== "object") return [];

  const key = h2hKey(homeTeam, awayTeam);
  const arr = h2h[key];

  return Array.isArray(arr) ? arr : [];
}

/* =========================================================
   LAMBDA per singola fonte (attacco di A vs difesa di B)
========================================================= */

// Classifica: forza attacco/difesa rispetto alla media lega
function lambdaFromStandings(homeStats, awayStats) {
  if (!homeStats || !awayStats) return null;

  const homeAttack = homeStats.goalsForPerGame / LEAGUE_HOME_XG;
  const awayDefense = awayStats.goalsAgainstPerGame / LEAGUE_HOME_XG;
  const awayAttack = awayStats.goalsForPerGame / LEAGUE_AWAY_XG;
  const homeDefense = homeStats.goalsAgainstPerGame / LEAGUE_HOME_XG;

  return {
    home: LEAGUE_HOME_XG * (0.6 * homeAttack + 0.4 * awayDefense),
    away: LEAGUE_AWAY_XG * (0.6 * awayAttack + 0.4 * homeDefense)
  };
}

// Forma: gol fatti/subiti nelle ultime 5, con fattore punti
function lambdaFromForm(homeForm, awayForm) {
  if (!homeForm || !awayForm) return null;

  const homeAttack = (homeForm.averageGoalsFor || 0) / LEAGUE_HOME_XG;
  const awayDefense = (awayForm.averageGoalsAgainst || 0) / LEAGUE_HOME_XG;
  const awayAttack = (awayForm.averageGoalsFor || 0) / LEAGUE_AWAY_XG;
  const homeDefense = (homeForm.averageGoalsAgainst || 0) / LEAGUE_HOME_XG;

  // fattore forma dai punti (0.88 - 1.12)
  const formFactor = (f) => {
    const matches = (f.last5 || []).length || 1;
    const rate = (f.pointsLast5 || 0) / (matches * 3);
    return clamp(0.88 + rate * 0.24, 0.88, 1.12);
  };

  return {
    home: LEAGUE_HOME_XG * (0.6 * homeAttack + 0.4 * awayDefense) * formFactor(homeForm),
    away: LEAGUE_AWAY_XG * (0.6 * awayAttack + 0.4 * homeDefense) * formFactor(awayForm)
  };
}

// Understat: xG fatti/subiti (piu' stabile dei gol: meno varianza)
function lambdaFromUnderstat(homeU, awayU) {
  if (!homeU || !awayU) return null;
  if (homeU.xgForPerGame === null || awayU.xgForPerGame === null) return null;

  const homeAttack = homeU.xgForPerGame / LEAGUE_AVG_XG;
  const awayDefense = (awayU.xgAgainstPerGame ?? LEAGUE_AVG_XG) / LEAGUE_AVG_XG;
  const awayAttack = awayU.xgForPerGame / LEAGUE_AVG_XG;
  const homeDefense = (homeU.xgAgainstPerGame ?? LEAGUE_AVG_XG) / LEAGUE_AVG_XG;

  return {
    home: LEAGUE_HOME_XG * (0.6 * homeAttack + 0.4 * awayDefense),
    away: LEAGUE_AWAY_XG * (0.6 * awayAttack + 0.4 * homeDefense)
  };
}

/* =========================================================
   EXPECTED GOALS FINALE
========================================================= */

function calculateExpectedGoals(body) {
  const homeTeam = body.homeTeam;
  const awayTeam = body.awayTeam;

  const homeStanding = getStandingStats(getStandingRow(body.standings, homeTeam));
  const awayStanding = getStandingStats(getStandingRow(body.standings, awayTeam));
  const homeForm = getFormEntry(body.form, homeTeam);
  const awayForm = getFormEntry(body.form, awayTeam);
  const homeU = getUnderstatEntry(body.understat, homeTeam);
  const awayU = getUnderstatEntry(body.understat, awayTeam);
  const h2hMatches = getH2HMatches(body.h2h, homeTeam, awayTeam);

  const sources = [];
  const factors = {
    directXG: false, understat: false, standings: false,
    form: false, homeAway: true, h2h: false
  };

  // ---- xG diretto BBD (se il piano lo fornisce): fonte primaria
  const matchXG = body?.match?.xG;
  let directXG = null;

  if (matchXG && typeof matchXG === "object") {
    const h = num(matchXG.homeXG ?? matchXG.home ?? matchXG.home_xg);
    const a = num(matchXG.awayXG ?? matchXG.away ?? matchXG.away_xg);

    if (h !== null && a !== null && h >= 0 && a >= 0) {
      directXG = { home: h, away: a };
      factors.directXG = true;
    }
  }

  // ---- sotto-modelli
  const lamTable = lambdaFromStandings(homeStanding, awayStanding);
  if (lamTable) { sources.push({ key: "standings", ...lamTable }); factors.standings = true; }

  const lamForm = lambdaFromForm(homeForm, awayForm);
  if (lamForm) { sources.push({ key: "form", ...lamForm }); factors.form = true; }

  const lamUS = lambdaFromUnderstat(homeU, awayU);
  if (lamUS) { sources.push({ key: "understat", ...lamUS }); factors.understat = true; }

  // base: sempre disponibile
  sources.push({ key: "base", home: 1.35, away: 1.05 });

  // ---- media pesata (rinormalizzata sui pesi disponibili)
  let totalW = 0;
  let homeXG = 0;
  let awayXG = 0;

  for (const s of sources) {
    const w = W[s.key] ?? 0.2;
    totalW += w;
    homeXG += s.home * w;
    awayXG += s.away * w;
  }

  homeXG /= totalW;
  awayXG /= totalW;

  // ---- H2H: SOLO ultimi 3 anni, aggiustamento massimo +/-5%
  const threeYearsAgo = Date.now() - 3 * 365 * 86400000;
  let h2hInfo = { available: false };

  const recentH2H = h2hMatches.filter((m) => {
    const t = new Date(m.date || 0).getTime();
    return t >= threeYearsAgo;
  });

  if (recentH2H.length >= 2) {
    const homeWanted = normalizeTeamName(homeTeam);
    let homeGoals = 0, awayGoals = 0, count = 0;

    for (const m of recentH2H.slice(0, 5)) {
      const h = num(m.homeGoals), a = num(m.awayGoals);
      if (h === null || a === null) continue;

      if (normalizeTeamName(m.homeTeam) === homeWanted) {
        homeGoals += h; awayGoals += a;
      } else {
        homeGoals += a; awayGoals += h;
      }
      count++;
    }

    if (count >= 2) {
      const avgH = homeGoals / count;
      const avgA = awayGoals / count;

      homeXG *= clamp(0.95 + (avgH / 1.45) * 0.05, 0.95, 1.05);
      awayXG *= clamp(0.95 + (avgA / 1.15) * 0.05, 0.95, 1.05);

      factors.h2h = true;
      h2hInfo = {
        available: true,
        matches: count,
        averageHomeGoals: Number(avgH.toFixed(2)),
        averageAwayGoals: Number(avgA.toFixed(2))
      };
    }
  }

  // ---- vantaggio casa (una sola volta, alla fine)
  homeXG *= 1.06;

  // ---- xG diretto: se presente, media 50/50 con il modello
  if (directXG) {
    homeXG = homeXG * 0.5 + directXG.home * 0.5;
    awayXG = awayXG * 0.5 + directXG.away * 0.5;
  }

  homeXG = clamp(homeXG, 0.15, 4.5);
  awayXG = clamp(awayXG, 0.10, 4.0);

  const used = sources.map((s) => s.key).filter((k) => k !== "base");
  if (factors.h2h) used.push("h2h");
  used.push("casa");

  return {
    home: Number(homeXG.toFixed(3)),
    away: Number(awayXG.toFixed(3)),
    source: factors.directXG
      ? "xG diretto BBD (50%) + modello"
      : `Modello: ${used.join(" + ")}`,
    factors,
    h2h: h2hInfo
  };
}

/* =========================================================
   DIXON-COLES + MERCATI (matematica invariata: era corretta)
========================================================= */

function dixonColesAdjustment(h, a, lambdaH, lambdaA) {
  const rho = DIXON_COLES_RHO;

  if (h === 0 && a === 0) return 1 - lambdaH * lambdaA * rho;
  if (h === 0 && a === 1) return 1 + lambdaH * rho;
  if (h === 1 && a === 0) return 1 + lambdaA * rho;
  if (h === 1 && a === 1) return 1 - rho;

  return 1;
}

function buildMatrix(homeXG, awayXG) {
  const matrix = [];
  let total = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    matrix[h] = [];

    for (let a = 0; a <= MAX_GOALS; a++) {
      const base =
        poisson(h, homeXG) * poisson(a, awayXG) *
        dixonColesAdjustment(h, a, homeXG, awayXG);

      const p = Math.max(0, base);
      matrix[h][a] = p;
      total += p;
    }
  }

  if (total > 0) {
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        matrix[h][a] /= total;
      }
    }
  }

  return matrix;
}

function calculate1X2(matrix) {
  let home = 0, draw = 0, away = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }

  return { home, draw, away };
}

function calculateDoubleChance(p) {
  return {
    "1X": p.home + p.draw,
    "X2": p.draw + p.away,
    "12": p.home + p.away
  };
}

function calculateOverUnder(matrix) {
  const r = { over15: 0, under15: 0, over25: 0, under25: 0, over35: 0, under35: 0 };

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      const goals = h + a;

      if (goals > 1.5) r.over15 += p; else r.under15 += p;
      if (goals > 2.5) r.over25 += p; else r.under25 += p;
      if (goals > 3.5) r.over35 += p; else r.under35 += p;
    }
  }

  return r;
}

function calculateBTTS(matrix) {
  let yes = 0, no = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;
      if (h > 0 && a > 0) yes += p; else no += p;
    }
  }

  return { yes, no };
}

function calculateExactScores(matrix) {
  const rows = [];

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      rows.push({
        score: `${h}-${a}`,
        home: h,
        away: a,
        probability: matrix[h][a] || 0
      });
    }
  }

  rows.sort((x, y) => y.probability - x.probability);

  return rows.slice(0, 10);
}

function calculateHandicap(matrix) {
  let homeMinus1 = 0, homePlus1 = 0, awayPlus1 = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = matrix[h][a] || 0;

      if (h - a > 1) homeMinus1 += p;
      if (h + 1 > a) homePlus1 += p;
      if (a + 1 > h) awayPlus1 += p;
    }
  }

  return { homeMinus1, homePlus1, awayPlus1 };
}

function fairOdd(probability) {
  if (!Number.isFinite(probability) || probability <= 0) return null;
  return Number((1 / probability).toFixed(2));
}

function calculateFairOdds(p, ou, btts) {
  return {
    home: fairOdd(p.home),
    draw: fairOdd(p.draw),
    away: fairOdd(p.away),
    over25: fairOdd(ou.over25),
    under25: fairOdd(ou.under25),
    bttsYes: fairOdd(btts.yes)
  };
}

function calculateConfidence(expected, body) {
  const f = expected.factors || {};
  let c = 48;

  if (f.standings) c += 8;
  if (f.form) c += 8;
  if (f.h2h) c += 4;
  if (f.understat) c += 12;   // xG = segnale piu' forte
  if (f.directXG) c += 18;

  return Math.round(clamp(c, 30, 95));
}

/* =========================================================
   TRACKING SUPABASE (backtest) - mai bloccante
========================================================= */

async function trackPrediction(body, expected, probabilities) {
  const supabase = getSupabase();
  if (!supabase) return;

  const matchId =
    body?.match?.id ??
    `${normalizeTeamName(body.homeTeam)}-${normalizeTeamName(body.awayTeam)}`;

  const pick =
    probabilities.home >= probabilities.draw &&
    probabilities.home >= probabilities.away
      ? "1"
      : probabilities.away >= probabilities.draw
        ? "2"
        : "X";

  try {
    await supabase.from("predictions").insert({
      match_id: String(matchId),
      home_team: body.homeTeam,
      away_team: body.awayTeam,
      predicted_at: new Date().toISOString(),
      xg_home: expected.home,
      xg_away: expected.away,
      prediction_1x2: pick,
      probabilities: {
        home: Number(probabilities.home.toFixed(4)),
        draw: Number(probabilities.draw.toFixed(4)),
        away: Number(probabilities.away.toFixed(4))
      },
      model: "v6-poisson-dc-multifactor"
    });
  } catch {
    // il tracking non deve mai rompere la previsione
  }
}

/* =========================================================
   HANDLER
========================================================= */

async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Usa POST per /api/predict."
    });
  }

  try {
    const body = await parseBody(req);

    const homeTeam = String(body.homeTeam || "").trim();
    const awayTeam = String(body.awayTeam || "").trim();
    const competition = String(body.competition || "seriea").trim();

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({
        ok: false, error: "MISSING_TEAMS",
        message: "homeTeam e awayTeam sono obbligatori."
      });
    }

    if (normalizeTeamName(homeTeam) === normalizeTeamName(awayTeam)) {
      return res.status(400).json({
        ok: false, error: "SAME_TEAM",
        message: "Le due squadre devono essere diverse."
      });
    }

    const expected = calculateExpectedGoals(body);
    const matrix = buildMatrix(expected.home, expected.away);

    const probabilities = calculate1X2(matrix);
    const doubleChance = calculateDoubleChance(probabilities);
    const overUnder = calculateOverUnder(matrix);
    const btts = calculateBTTS(matrix);
    const exactScores = calculateExactScores(matrix);
    const handicap = calculateHandicap(matrix);
    const fairOdds = calculateFairOdds(probabilities, overUnder, btts);
    const confidence = calculateConfidence(expected, body);

    // tracking asincrono: non aspettiamo Supabase per rispondere
    const tracking = trackPrediction(body, expected, probabilities);
    const trackingTimeout = new Promise((r) => setTimeout(r, 2500));
    await Promise.race([tracking, trackingTimeout]);

    return res.status(200).json({
      ok: true,
      competition,
      homeTeam,
      awayTeam,
      model: "V6 Multi-factor Poisson + Dixon-Coles (BBD + Understat)",
      xgSource: expected.source,
      inputXG: { home: expected.home, away: expected.away },
      expectedGoals: {
        home: Number(expected.home.toFixed(2)),
        away: Number(expected.away.toFixed(2))
      },
      factorsUsed: expected.factors,
      h2h: expected.h2h,
      probabilities,
      doubleChance,
      overUnder,
      btts,
      handicap,
      exactScores,
      fairOdds,
      confidence
    });

  } catch (error) {
    console.error("PREDICT ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "PREDICTION_ERROR",
      message: error?.message || "Errore interno nel modello."
    });
  }
}
