const MAX_GOALS = 10;
const DIXON_COLES_RHO = -0.08;

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeXG(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 8) return null;

  return n;
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function getAliases() {
  return {
    "inter milan": "inter",
    "internazionale": "inter",
    "como 1907": "como",
    "as roma": "roma",
    "ac milan": "milan",
    "venezia fc": "venezia"
  };
}

function canonicalTeamName(name) {
  const normalized = normalizeName(name);
  const aliases = getAliases();

  return aliases[normalized] || normalized;
}

function getMatchXG(body) {
  const matchXG = body?.match?.xG;

  if (matchXG) {
    const home = normalizeXG(
      matchXG.homeXG ??
      matchXG.home ??
      matchXG.home_xg
    );

    const away = normalizeXG(
      matchXG.awayXG ??
      matchXG.away ??
      matchXG.away_xg
    );

    if (home !== null && away !== null) {
      return {
        homeXG: home,
        awayXG: away
      };
    }
  }

  const home = normalizeXG(
    body?.homeXG ??
    body?.home_xg
  );

  const away = normalizeXG(
    body?.awayXG ??
    body?.away_xg
  );

  if (home !== null && away !== null) {
    return {
      homeXG: home,
      awayXG: away
    };
  }

  return null;
}

function getStandingForTeam(standings, teamName) {
  if (!Array.isArray(standings)) {
    return null;
  }

  const target = canonicalTeamName(teamName);

  return (
    standings.find((row) => {
      const name =
        row?.team_name ??
        row?.teamName ??
        row?.name ??
        row?.team?.name;

      return canonicalTeamName(name) === target;
    }) || null
  );
}

function buildTeamStrength(standing, isHome) {
  /*
    BBD standings:
    wins, losses, ties, games_played,
    points_for, points_against, rank.

    "points_for/against" nella risposta BBD
    sono i gol fatti/subiti per il calcio.
  */

  if (!standing) {
    return {
      attack: 1,
      defense: 1,
      rankFactor: 1
    };
  }

  const played = Math.max(
    1,
    number(
      standing.games_played ??
      standing.played ??
      standing.matches_played,
      1
    )
  );

  const goalsFor = number(
    standing.points_for ??
    standing.goals_for ??
    standing.gf
  );

  const goalsAgainst = number(
    standing.points_against ??
    standing.goals_against ??
    standing.ga
  );

  const rank = number(standing.rank, 10);

  /*
    Media Serie A neutrale approssimativa.
    Serve solo come punto di riferimento per
    normalizzare i dati della classifica.
  */
  const leagueGoalsPerTeam = 1.35;

  const goalsForPerGame =
    goalsFor > 0
      ? goalsFor / played
      : leagueGoalsPerTeam;

  const goalsAgainstPerGame =
    goalsAgainst >= 0
      ? goalsAgainst / played
      : leagueGoalsPerTeam;

  let attack =
    goalsForPerGame /
    leagueGoalsPerTeam;

  let defense =
    goalsAgainstPerGame /
    leagueGoalsPerTeam;

  /*
    Limitiamo l'effetto della classifica.
    Una squadra con 4 partite non deve diventare
    automaticamente una superpotenza.
  */
  attack = clamp(attack, 0.65, 1.55);
  defense = clamp(defense, 0.65, 1.55);

  /*
    Piccolo aggiustamento dal ranking.
    Rank 1 ≈ +5%, rank 20 ≈ -5%.
  */
  const rankFactor = clamp(
    1.05 - ((rank - 1) / 19) * 0.10,
    0.95,
    1.05
  );

  if (isHome) {
    attack *= rankFactor;
  } else {
    attack *= rankFactor;
  }

  return {
    attack,
    defense,
    rankFactor
  };
}

function getFallbackXG(body) {
  const homeTeam =
    body?.match?.home?.name ??
    body?.homeTeam ??
    body?.home ??
    "";

  const awayTeam =
    body?.match?.away?.name ??
    body?.awayTeam ??
    body?.away ??
    "";

  const standings = Array.isArray(body?.standings)
    ? body.standings
    : [];

  const homeStanding =
    getStandingForTeam(
      standings,
      homeTeam
    );

  const awayStanding =
    getStandingForTeam(
      standings,
      awayTeam
    );

  const homeStrength =
    buildTeamStrength(
      homeStanding,
      true
    );

  const awayStrength =
    buildTeamStrength(
      awayStanding,
      false
    );

  /*
    Forza offensiva della squadra
    × debolezza difensiva avversaria.
  */

  let homeXG =
    1.35 *
    homeStrength.attack *
    awayStrength.defense;

  let awayXG =
    1.05 *
    awayStrength.attack *
    homeStrength.defense;

  /*
    Vantaggio campo.
  */
  homeXG *= 1.10;

  /*
    Evitiamo valori estremi.
  */
  homeXG = clamp(homeXG, 0.35, 3.40);
  awayXG = clamp(awayXG, 0.25, 3.00);

  /*
    Se il frontend passa valori manuali di attack,
    li usiamo come ulteriore informazione.
  */
  const manualHomeAttack =
    number(body?.homeAttack, 0);

  const manualAwayAttack =
    number(body?.awayAttack, 0);

  if (manualHomeAttack > 0) {
    homeXG =
      homeXG * 0.75 +
      clamp(manualHomeAttack, 0.35, 3.5) * 0.25;
  }

  if (manualAwayAttack > 0) {
    awayXG =
      awayXG * 0.75 +
      clamp(manualAwayAttack, 0.25, 3.0) * 0.25;
  }

  return {
    homeXG: clamp(homeXG, 0.35, 3.40),
    awayXG: clamp(awayXG, 0.25, 3.00),
    homeStanding,
    awayStanding
  };
}

function applyDixonColes(matrix, homeXG, awayXG) {
  /*
    Correzione Dixon-Coles per gli score bassi.
  */

  const corrected = matrix.map(
    (row) => [...row]
  );

  const rho = DIXON_COLES_RHO;

  const p00 =
    corrected[0]?.[0] ?? 0;

  const p01 =
    corrected[0]?.[1] ?? 0;

  const p10 =
    corrected[1]?.[0] ?? 0;

  const p11 =
    corrected[1]?.[1] ?? 0;

  if (corrected[0]?.[0] !== undefined) {
    corrected[0][0] =
      p00 *
      (1 - homeXG * awayXG * rho);
  }

  if (corrected[0]?.[1] !== undefined) {
    corrected[0][1] =
      p01 *
      (1 + homeXG * rho);
  }

  if (corrected[1]?.[0] !== undefined) {
    corrected[1][0] =
      p10 *
      (1 + awayXG * rho);
  }

  if (corrected[1]?.[1] !== undefined) {
    corrected[1][1] =
      p11 *
      (1 - rho);
  }

  return corrected;
}

function calculateMatrix(homeXG, awayXG) {
  const matrix = [];

  for (let home = 0; home <= MAX_GOALS; home++) {
    const row = [];

    for (
      let away = 0;
      away <= MAX_GOALS;
      away++
    ) {
      row.push(
        poisson(home, homeXG) *
        poisson(away, awayXG)
      );
    }

    matrix.push(row);
  }

  return applyDixonColes(
    matrix,
    homeXG,
    awayXG
  );
}

function normalizeMatrix(matrix) {
  let total = 0;

  for (const row of matrix) {
    for (const value of row) {
      total += value;
    }
  }

  if (total <= 0) {
    return matrix;
  }

  return matrix.map(
    (row) =>
      row.map(
        (value) => value / total
      )
  );
}

function calculateMarkets(matrix) {
  let home = 0;
  let draw = 0;
  let away = 0;

  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  let btts = 0;

  const exactScores = [];

  for (let h = 0; h < matrix.length; h++) {
    for (
      let a = 0;
      a < matrix[h].length;
      a++
    ) {
      const probability = matrix[h][a];

      if (h > a) home += probability;
      else if (h === a) draw += probability;
      else away += probability;

      if (h + a > 1.5) {
        over15 += probability;
      }

      if (h + a > 2.5) {
        over25 += probability;
      }

      if (h + a > 3.5) {
        over35 += probability;
      }

      if (h > 0 && a > 0) {
        btts += probability;
      }

      exactScores.push({
        score: `${h}-${a}`,
        probability
      });
    }
  }

  exactScores.sort(
    (a, b) =>
      b.probability -
      a.probability
  );

  return {
    oneXTwo: {
      home,
      draw,
      away
    },

    doubleChance: {
      "1X": home + draw,
      "X2": draw + away,
      "12": home + away
    },

    overUnder: {
      over15,
      under15: 1 - over15,

      over25,
      under25: 1 - over25,

      over35,
      under35: 1 - over35
    },

    btts: {
      yes: btts,
      no: 1 - btts
    },

    exactScores:
      exactScores.slice(0, 10)
  };
}

function fairOdds(probability) {
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

function calculateConfidence({
  xgSource,
  homeStanding,
  awayStanding,
  match
}) {
  let confidence = 48;

  if (xgSource === "BBD match xG") {
    confidence += 22;
  }

  if (xgSource === "BBD/API xG") {
    confidence += 18;
  }

  if (homeStanding && awayStanding) {
    confidence += 10;
  }

  if (match?.status) {
    confidence += 3;
  }

  /*
    Se le due squadre hanno pochissime partite,
    riduciamo leggermente la fiducia.
  */
  const homeGames = number(
    homeStanding?.games_played,
    0
  );

  const awayGames = number(
    awayStanding?.games_played,
    0
  );

  if (
    homeGames > 0 &&
    homeGames < 5
  ) {
    confidence -= 4;
  }

  if (
    awayGames > 0 &&
    awayGames < 5
  ) {
    confidence -= 4;
  }

  return clamp(
    Math.round(confidence),
    30,
    90
  );
}

function parseBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Usa POST per /api/predict."
    });
  }

  try {
    const body = parseBody(req);

    const match = body.match || {};

    const homeTeam =
      match?.home?.name ??
      body.homeTeam ??
      body.home ??
      "Casa";

    const awayTeam =
      match?.away?.name ??
      body.awayTeam ??
      body.away ??
      "Trasferta";

    // --------------------------------------------------
    // XG REALE, SE PRESENTE
    // --------------------------------------------------

    const realXG = getMatchXG(body);

    let homeXG;
    let awayXG;
    let xgSource;

    let homeStanding = null;
    let awayStanding = null;

    if (realXG) {
      homeXG = realXG.homeXG;
      awayXG = realXG.awayXG;

      xgSource = "BBD match xG";
    } else {
      const fallback =
        getFallbackXG(body);

      homeXG = fallback.homeXG;
      awayXG = fallback.awayXG;

      homeStanding =
        fallback.homeStanding;

      awayStanding =
        fallback.awayStanding;

      xgSource =
        homeStanding &&
        awayStanding
          ? "BBD/API xG"
          : "Classifica + fallback";
    }

    // --------------------------------------------------
    // MODELLO
    // --------------------------------------------------

    let matrix =
      calculateMatrix(
        homeXG,
        awayXG
      );

    matrix =
      normalizeMatrix(matrix);

    const markets =
      calculateMarkets(matrix);

    const confidence =
      calculateConfidence({
        xgSource,
        homeStanding,
        awayStanding,
        match
      });

    // --------------------------------------------------
    // QUOTE FAIR
    // --------------------------------------------------

    const fair = {
      home: fairOdds(
        markets.oneXTwo.home
      ),

      draw: fairOdds(
        markets.oneXTwo.draw
      ),

      away: fairOdds(
        markets.oneXTwo.away
      ),

      over25: fairOdds(
        markets.overUnder.over25
      ),

      under25: fairOdds(
        markets.overUnder.under25
      ),

      bttsYes: fairOdds(
        markets.btts.yes
      ),

      bttsNo: fairOdds(
        markets.btts.no
      )
    };

    // --------------------------------------------------
    // RISULTATO PIÙ PROBABILE
    // --------------------------------------------------

    const topScore =
      markets.exactScores[0] || null;

    const outcomes = [
      {
        outcome: "1",
        probability:
          markets.oneXTwo.home
      },
      {
        outcome: "X",
        probability:
          markets.oneXTwo.draw
      },
      {
        outcome: "2",
        probability:
          markets.oneXTwo.away
      }
    ].sort(
      (a, b) =>
        b.probability -
        a.probability
    );

    return res.status(200).json({
      ok: true,

      match: {
        home: homeTeam,
        away: awayTeam
      },

      model: {
        name: "Poisson + Dixon-Coles",
        xG: {
          home: Number(
            homeXG.toFixed(3)
          ),
          away: Number(
            awayXG.toFixed(3)
          )
        },

        xGSource: xgSource,

        confidence
      },

      prediction: {
        oneXTwo:
          markets.oneXTwo,

        mostLikely:
          outcomes[0],

        doubleChance:
          markets.doubleChance,

        overUnder:
          markets.overUnder,

        btts:
          markets.btts,

        exactScores:
          markets.exactScores
      },

      fairOdds: fair,

      topScore,

      inputs: {
        homeStanding,
        awayStanding
      },

      generatedAt:
        new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "PREDICTION_FAILED",
      message:
        error?.message ||
        "Errore durante il calcolo della previsione."
    });
  }
}
