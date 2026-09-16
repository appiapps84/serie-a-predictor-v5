const MAX_GOALS = 10;
const DIXON_COLES_RHO = -0.08;

const ALIASES = {
  "inter milan": "inter",
  "internazionale": "inter",
  "como 1907": "como",
  "as roma": "roma",
  "ac milan": "milan",
  "venezia fc": "venezia"
};

function normalizeName(value) {
  const raw = String(value || "").trim().toLowerCase();
  return ALIASES[raw] || raw;
}

function poisson(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) {
    return k === 0 ? 1 : 0;
  }

  let factorial = 1;

  for (let i = 2; i <= k; i++) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial
  );
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* =========================================================
   TEAM / STANDINGS
========================================================= */

function findStanding(standings, teamName) {
  if (!Array.isArray(standings)) return null;

  const wanted = normalizeName(teamName);

  return standings.find(row => {
    const candidates = [
      row?.team_name,
      row?.teamName,
      row?.name,
      row?.team?.name
    ];

    return candidates.some(value => {
      const current = normalizeName(value);

      return (
        current === wanted ||
        current.includes(wanted) ||
        wanted.includes(current)
      );
    });
  }) || null;
}

function getStandingStats(row) {
  if (!row) return null;

  const games = number(
    row.games_played ??
    row.played ??
    row.games
  );

  const gf = number(
    row.points_for ??
    row.goals_for ??
    row.gf
  );

  const ga = number(
    row.points_against ??
    row.goals_against ??
    row.ga
  );

  if (
    games === null ||
    games <= 0 ||
    gf === null ||
    ga === null
  ) {
    return null;
  }

  return {
    games,
    goalsFor: gf,
    goalsAgainst: ga,
    goalsForPerGame: gf / games,
    goalsAgainstPerGame: ga / games,
    points: number(row.points) ?? 0
  };
}

/* =========================================================
   FORM
========================================================= */

function getForm(form, teamName) {
  if (!form || typeof form !== "object") {
    return null;
  }

  const wanted = normalizeName(teamName);

  for (const [key, value] of Object.entries(form)) {
    const candidates = [
      key,
      value?.team
    ];

    if (
      candidates.some(candidate => {
        const current = normalizeName(candidate);

        return (
          current === wanted ||
          current.includes(wanted) ||
          wanted.includes(current)
        );
      })
    ) {
      return value;
    }
  }

  return null;
}

function calculateFormFactor(teamForm) {
  if (!teamForm) return 1;

  const matches =
    number(teamForm.last5?.length) ??
    0;

  if (matches <= 0) return 1;

  const points =
    number(teamForm.pointsLast5) ??
    0;

  /*
    Massimo 15 punti nelle ultime 5.
    La forma modifica moderatamente il valore,
    evitando che 5 partite dominino il modello.
  */

  const pointsRate = points / (matches * 3);

  return clamp(
    0.88 + pointsRate * 0.24,
    0.88,
    1.12
  );
}

function calculateRecentAttack(teamForm) {
  if (!teamForm) return null;

  const value = number(
    teamForm.averageGoalsFor
  );

  if (value === null || value <= 0) {
    return null;
  }

  return value;
}

function calculateRecentDefense(teamForm) {
  if (!teamForm) return null;

  const value = number(
    teamForm.averageGoalsAgainst
  );

  if (value === null || value < 0) {
    return null;
  }

  return value;
}

/* =========================================================
   H2H
========================================================= */

function getH2H(h2h, homeTeam, awayTeam) {
  if (!h2h || typeof h2h !== "object") {
    return [];
  }

  const home = normalizeName(homeTeam);
  const away = normalizeName(awayTeam);

  const directKey =
    home < away
      ? `${home}__${away}`
      : `${away}__${home}`;

  return Array.isArray(h2h[directKey])
    ? h2h[directKey]
    : [];
}

function calculateH2HFactor(
  matches,
  homeTeam,
  awayTeam
) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {
      homeFactor: 1,
      awayFactor: 1,
      available: false
    };
  }

  const homeWanted = normalizeName(homeTeam);
  const awayWanted = normalizeName(awayTeam);

  let homeGoals = 0;
  let awayGoals = 0;
  let count = 0;

  for (const match of matches.slice(0, 5)) {
    const h = number(match.homeGoals);
    const a = number(match.awayGoals);

    if (h === null || a === null) continue;

    const matchHome = normalizeName(match.homeTeam);
    const matchAway = normalizeName(match.awayTeam);

    if (
      matchHome === homeWanted &&
      matchAway === awayWanted
    ) {
      homeGoals += h;
      awayGoals += a;
      count++;
    } else if (
      matchHome === awayWanted &&
      matchAway === homeWanted
    ) {
      homeGoals += a;
      awayGoals += h;
      count++;
    }
  }

  if (count === 0) {
    return {
      homeFactor: 1,
      awayFactor: 1,
      available: false
    };
  }

  const avgHome = homeGoals / count;
  const avgAway = awayGoals / count;

  return {
    homeFactor: clamp(
      0.92 + (avgHome / 1.45) * 0.08,
      0.94,
      1.06
    ),
    awayFactor: clamp(
      0.94 + (avgAway / 1.15) * 0.06,
      0.95,
      1.05
    ),
    available: true,
    matches: count,
    averageHomeGoals: avgHome,
    averageAwayGoals: avgAway
  };
}

/* =========================================================
   DIRECT XG
========================================================= */

function getDirectXG(body) {
  const matchXG =
    body?.match?.xG ??
    body?.match?.xg ??
    body?.xG ??
    body?.xg;

  if (matchXG && typeof matchXG === "object") {
    const home = number(
      matchXG.homeXG ??
      matchXG.home ??
      matchXG.home_xg ??
      matchXG.home_xG
    );

    const away = number(
      matchXG.awayXG ??
      matchXG.away ??
      matchXG.away_xg ??
      matchXG.away_xG
    );

    if (
      home !== null &&
      away !== null &&
      home >= 0 &&
      away >= 0
    ) {
      return {
        home,
        away,
        source: "BBD match xG"
      };
    }
  }

  const home = number(
    body?.homeXG ??
    body?.home_xg
  );

  const away = number(
    body?.awayXG ??
    body?.away_xg
  );

  if (
    home !== null &&
    away !== null &&
    home >= 0 &&
    away >= 0
  ) {
    return {
      home,
      away,
      source: "BBD/API xG"
    };
  }

  return null;
}

/* =========================================================
   MULTI-FACTOR EXPECTED GOALS
========================================================= */

function calculateExpectedGoals(body) {
  const homeTeam = body.homeTeam;
  const awayTeam = body.awayTeam;

  const directXG = getDirectXG(body);

  if (directXG) {
    return {
      home: clamp(directXG.home, 0.15, 4.5),
      away: clamp(directXG.away, 0.10, 4.0),
      source: directXG.source,
      factors: {
        directXG: true,
        standings: false,
        form: false,
        homeAway: false,
        h2h: false
      }
    };
  }

  const homeStanding =
    getStandingStats(
      findStanding(
        body.standings,
        homeTeam
      )
    );

  const awayStanding =
    getStandingStats(
      findStanding(
        body.standings,
        awayTeam
      )
    );

  const homeForm =
    getForm(body.form, homeTeam);

  const awayForm =
    getForm(body.form, awayTeam);

  const h2hMatches =
    getH2H(
      body.h2h,
      homeTeam,
      awayTeam
    );

  const h2h =
    calculateH2HFactor(
      h2hMatches,
      homeTeam,
      awayTeam
    );

  /*
    Base Serie A.
  */

  let homeXG = 1.35;
  let awayXG = 1.05;

  let standingsUsed = false;
  let formUsed = false;
  let homeAwayUsed = false;

  /* ---------------------------------------------------------
     CLASSIFICA
  --------------------------------------------------------- */

  if (homeStanding && awayStanding) {
    const leagueHome = 1.45;
    const leagueAway = 1.15;

    const homeAttack =
      homeStanding.goalsForPerGame;

    const homeDefense =
      homeStanding.goalsAgainstPerGame;

    const awayAttack =
      awayStanding.goalsForPerGame;

    const awayDefense =
      awayStanding.goalsAgainstPerGame;

    homeXG =
      leagueHome *
      (
        0.60 *
          (homeAttack / leagueHome) +
        0.40 *
          (awayDefense / leagueHome)
      );

    awayXG =
      leagueAway *
      (
        0.60 *
          (awayAttack / leagueAway) +
        0.40 *
          (homeDefense / leagueHome)
      );

    standingsUsed = true;
  }

  /* ---------------------------------------------------------
     FORMA RECENTE
  --------------------------------------------------------- */

  const homeFormFactor =
    calculateFormFactor(homeForm);

  const awayFormFactor =
    calculateFormFactor(awayForm);

  const homeRecentAttack =
    calculateRecentAttack(homeForm);

  const awayRecentAttack =
    calculateRecentAttack(awayForm);

  const homeRecentDefense =
    calculateRecentDefense(homeForm);

  const awayRecentDefense =
    calculateRecentDefense(awayForm);

  if (
    homeForm &&
    awayForm
  ) {
    /*
      La forma pesa il 20%.
    */

    if (homeRecentAttack !== null) {
      homeXG =
        homeXG * 0.80 +
        homeRecentAttack * 0.20;
    }

    if (awayRecentAttack !== null) {
      awayXG =
        awayXG * 0.80 +
        awayRecentAttack * 0.20;
    }

    /*
      La difesa recente corregge leggermente
      la previsione offensiva dell'avversaria.
    */

    if (awayRecentDefense !== null) {
      homeXG *= clamp(
        0.85 +
          awayRecentDefense / 2.0 * 0.15,
        0.90,
        1.10
      );
    }

    if (homeRecentDefense !== null) {
      awayXG *= clamp(
        0.85 +
          homeRecentDefense / 2.0 * 0.15,
        0.90,
        1.10
      );
    }

    homeXG *= homeFormFactor;
    awayXG *= awayFormFactor;

    formUsed = true;
  }

  /* ---------------------------------------------------------
     VANTAGGIO CASA
  --------------------------------------------------------- */

  homeXG *= 1.06;

  homeAwayUsed = true;

  /* ---------------------------------------------------------
     H2H
  --------------------------------------------------------- */

  if (h2h.available) {
    homeXG *= h2h.homeFactor;
    awayXG *= h2h.awayFactor;
  }

  homeXG = clamp(homeXG, 0.15, 4.5);
  awayXG = clamp(awayXG, 0.10, 4.0);

  let sourceParts = [];

  if (standingsUsed) {
    sourceParts.push("classifica");
  }

  if (formUsed) {
    sourceParts.push("forma");
  }

  if (homeAwayUsed) {
    sourceParts.push("casa/trasferta");
  }

  if (h2h.available) {
    sourceParts.push("H2H");
  }

  return {
    home: homeXG,
    away: awayXG,

    source:
      sourceParts.length > 0
        ? `Modello multi-fattore: ${sourceParts.join(" + ")}`
        : "Fallback model",

    factors: {
      directXG: false,
      standings: standingsUsed,
      form: formUsed,
      homeAway: homeAwayUsed,
      h2h: h2h.available
    },

    h2h
  };
}

/* =========================================================
   DIXON COLES
========================================================= */

function dixonColesAdjustment(
  homeGoals,
  awayGoals,
  homeLambda,
  awayLambda
) {
  const rho = DIXON_COLES_RHO;

  if (
    homeGoals === 0 &&
    awayGoals === 0
  ) {
    return 1 -
      homeLambda *
      awayLambda *
      rho;
  }

  if (
    homeGoals === 0 &&
    awayGoals === 1
  ) {
    return 1 +
      homeLambda *
      rho;
  }

  if (
    homeGoals === 1 &&
    awayGoals === 0
  ) {
    return 1 +
      awayLambda *
      rho;
  }

  if (
    homeGoals === 1 &&
    awayGoals === 1
  ) {
    return 1 - rho;
  }

  return 1;
}

function buildMatrix(homeXG, awayXG) {
  const matrix = [];
  let total = 0;

  for (
    let homeGoals = 0;
    homeGoals <= MAX_GOALS;
    homeGoals++
  ) {
    matrix[homeGoals] = [];

    for (
      let awayGoals = 0;
      awayGoals <= MAX_GOALS;
      awayGoals++
    ) {
      const base =
        poisson(homeGoals, homeXG) *
        poisson(awayGoals, awayXG);

      const adjustment =
        dixonColesAdjustment(
          homeGoals,
          awayGoals,
          homeXG,
          awayXG
        );

      const probability =
        Math.max(
          0,
          base * adjustment
        );

      matrix[homeGoals][awayGoals] =
        probability;

      total += probability;
    }
  }

  if (total > 0) {
    for (
      let h = 0;
      h <= MAX_GOALS;
      h++
    ) {
      for (
        let a = 0;
        a <= MAX_GOALS;
        a++
      ) {
        matrix[h][a] /= total;
      }
    }
  }

  return matrix;
}

/* =========================================================
   1X2
========================================================= */

function calculate1X2(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      const p =
        matrix[h][a] || 0;

      if (h > a) {
        home += p;
      } else if (h === a) {
        draw += p;
      } else {
        away += p;
      }
    }
  }

  return {
    home,
    draw,
    away
  };
}

/* =========================================================
   DOUBLE CHANCE
========================================================= */

function calculateDoubleChance(probabilities) {
  return {
    "1X":
      probabilities.home +
      probabilities.draw,

    "X2":
      probabilities.draw +
      probabilities.away,

    "12":
      probabilities.home +
      probabilities.away
  };
}

/* =========================================================
   OVER / UNDER
========================================================= */

function calculateOverUnder(matrix) {
  const result = {
    over15: 0,
    under15: 0,
    over25: 0,
    under25: 0,
    over35: 0,
    under35: 0
  };

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      const p =
        matrix[h][a] || 0;

      const goals =
        h + a;

      if (goals > 1.5) {
        result.over15 += p;
      } else {
        result.under15 += p;
      }

      if (goals > 2.5) {
        result.over25 += p;
      } else {
        result.under25 += p;
      }

      if (goals > 3.5) {
        result.over35 += p;
      } else {
        result.under35 += p;
      }
    }
  }

  return result;
}

/* =========================================================
   BTTS
========================================================= */

function calculateBTTS(matrix) {
  let yes = 0;
  let no = 0;

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      const p =
        matrix[h][a] || 0;

      if (h > 0 && a > 0) {
        yes += p;
      } else {
        no += p;
      }
    }
  }

  return {
    yes,
    no
  };
}

/* =========================================================
   EXACT SCORES
========================================================= */

function calculateExactScores(matrix) {
  const rows = [];

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      rows.push({
        score: `${h}-${a}`,
        home: h,
        away: a,
        probability:
          matrix[h][a] || 0
      });
    }
  }

  rows.sort(
    (a, b) =>
      b.probability -
      a.probability
  );

  return rows.slice(0, 10);
}

/* =========================================================
   HANDICAP
========================================================= */

function calculateHandicap(matrix) {
  let homeMinus1 = 0;
  let homePlus1 = 0;
  let awayPlus1 = 0;

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {
    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {
      const p =
        matrix[h][a] || 0;

      /*
        Casa -1:
        vittoria se casa segna almeno 2 gol
        più dell'ospite.
      */

      if (h - a > 1) {
        homeMinus1 += p;
      }

      /*
        Casa +1:
        vittoria se casa non perde di 2 o più.
      */

      if (h + 1 > a) {
        homePlus1 += p;
      }

      /*
        Ospite +1:
        vittoria se ospite non perde di 2 o più.
      */

      if (a + 1 > h) {
        awayPlus1 += p;
      }
    }
  }

  return {
    homeMinus1,
    homePlus1,
    awayPlus1
  };
}

/* =========================================================
   FAIR ODDS
========================================================= */

function fairOdd(probability) {
  if (
    !Number.isFinite(probability) ||
    probability <= 0
  ) {
    return null;
  }

  return Number(
    (1 / probability).toFixed(2)
  );
}

function calculateFairOdds(
  probabilities,
  overUnder,
  btts,
  handicap
) {
  return {
    home: fairOdd(
      probabilities.home
    ),

    draw: fairOdd(
      probabilities.draw
    ),

    away: fairOdd(
      probabilities.away
    ),

    over15: fairOdd(
      overUnder.over15
    ),

    under15: fairOdd(
      overUnder.under15
    ),

    over25: fairOdd(
      overUnder.over25
    ),

    under25: fairOdd(
      overUnder.under25
    ),

    over35: fairOdd(
      overUnder.over35
    ),

    under35: fairOdd(
      overUnder.under35
    ),

    bttsYes: fairOdd(
      btts.yes
    ),

    bttsNo: fairOdd(
      btts.no
    ),

    handicapHomeMinus1:
      fairOdd(
        handicap.homeMinus1
      ),

    handicapHomePlus1:
      fairOdd(
        handicap.homePlus1
      ),

    handicapAwayPlus1:
      fairOdd(
        handicap.awayPlus1
      )
  };
}

/* =========================================================
   CONFIDENCE
========================================================= */

function calculateConfidence(
  expectedGoalsData,
  body
) {
  let confidence = 48;

  const factors =
    expectedGoalsData.factors || {};

  if (factors.standings) {
    confidence += 10;
  }

  if (factors.form) {
    confidence += 12;
  }

  if (factors.homeAway) {
    confidence += 5;
  }

  if (factors.h2h) {
    confidence += 5;
  }

  /*
    In futuro:
    + infortuni
    + lineup
    + xG reale
  */

  if (factors.directXG) {
    confidence += 20;
  }

  if (
    Array.isArray(body.lineups) &&
    body.lineups.length > 0
  ) {
    confidence += 5;
  }

  if (
    Array.isArray(body.injuries) &&
    body.injuries.length > 0
  ) {
    confidence += 3;
  }

  return Math.round(
    clamp(
      confidence,
      30,
      95
    )
  );
}

/* =========================================================
   BODY
========================================================= */

async function parseBody(req) {
  if (
    req.body &&
    typeof req.body === "object"
  ) {
    return req.body;
  }

  if (
    typeof req.body === "string"
  ) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

/* =========================================================
   HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message:
        "Usa POST per /api/predict."
    });
  }

  try {
    const body =
      await parseBody(req);

    const homeTeam =
      String(
        body.homeTeam || ""
      ).trim();

    const awayTeam =
      String(
        body.awayTeam || ""
      ).trim();

    const competition =
      String(
        body.competition ||
        "seriea"
      ).trim();

    if (
      !homeTeam ||
      !awayTeam
    ) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_TEAMS",
        message:
          "homeTeam e awayTeam sono obbligatori."
      });
    }

    if (
      normalizeName(homeTeam) ===
      normalizeName(awayTeam)
    ) {
      return res.status(400).json({
        ok: false,
        error: "SAME_TEAM",
        message:
          "Le due squadre devono essere diverse."
      });
    }

    /* -------------------------------------------------------
       EXPECTED GOALS
    ------------------------------------------------------- */

    const expected =
      calculateExpectedGoals(body);

    const homeXG =
      expected.home;

    const awayXG =
      expected.away;

    /* -------------------------------------------------------
       MODEL MATRIX
    ------------------------------------------------------- */

    const matrix =
      buildMatrix(
        homeXG,
        awayXG
      );

    /* -------------------------------------------------------
       MARKETS
    ------------------------------------------------------- */

    const probabilities =
      calculate1X2(matrix);

    const doubleChance =
      calculateDoubleChance(
        probabilities
      );

    const overUnder =
      calculateOverUnder(
        matrix
      );

    const btts =
      calculateBTTS(
        matrix
      );

    const exactScores =
      calculateExactScores(
        matrix
      );

    const handicap =
      calculateHandicap(
        matrix
      );

    const fairOdds =
      calculateFairOdds(
        probabilities,
        overUnder,
        btts,
        handicap
      );

    const confidence =
      calculateConfidence(
        expected,
        body
      );

    /* -------------------------------------------------------
       RESPONSE
    ------------------------------------------------------- */

    return res.status(200).json({
      ok: true,

      competition,

      homeTeam,

      awayTeam,

      model:
        "Multi-factor Poisson + Dixon-Coles",

      xgSource:
        expected.source,

      inputXG: {
        home:
          Number(
            homeXG.toFixed(3)
          ),

        away:
          Number(
            awayXG.toFixed(3)
          )
      },

      expectedGoals: {
        home:
          Number(
            homeXG.toFixed(2)
          ),

        away:
          Number(
            awayXG.toFixed(2)
          )
      },

      factorsUsed:
        expected.factors,

      h2h:
        expected.h2h,

      probabilities: {
        home:
          probabilities.home,

        draw:
          probabilities.draw,

        away:
          probabilities.away
      },

      doubleChance,

      overUnder,

      btts,

      handicap,

      exactScores,

      fairOdds,

      confidence
    });

  } catch (error) {
    console.error(
      "PREDICT ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "PREDICTION_ERROR",
      message:
        error?.message ||
        "Errore interno nel modello."
    });
  }
}
