const MAX_GOALS = 10;

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

function normalizeXG(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  if (number < 0 || number > 10) {
    return null;
  }

  return number;
}

function getMatchXG(body) {
  // -------------------------
  // match.xG
  // -------------------------
  if (body.match?.xG) {
    const home = normalizeXG(
      body.match.xG.homeXG ??
      body.match.xG.home ??
      body.match.xG.home_xg
    );

    const away = normalizeXG(
      body.match.xG.awayXG ??
      body.match.xG.away ??
      body.match.xG.away_xg
    );

    if (
      home !== null &&
      away !== null
    ) {
      return {
        homeXG: home,
        awayXG: away,
      };
    }
  }

  // -------------------------
  // root xG
  // -------------------------
  const home = normalizeXG(
    body.homeXG ??
    body.home_xg
  );

  const away = normalizeXG(
    body.awayXG ??
    body.away_xg
  );

  if (
    home !== null &&
    away !== null
  ) {
    return {
      homeXG: home,
      awayXG: away,
    };
  }

  return null;
}

function getFallbackXG(body) {
  /*
   * Se non abbiamo xG BBS, utilizziamo valori
   * conservativi di fallback.
   */

  const homeAttack = Number(
    body.homeAttack
  );

  const awayAttack = Number(
    body.awayAttack
  );

  const home =
    Number.isFinite(homeAttack) &&
    homeAttack > 0
      ? homeAttack
      : 1.35;

  const away =
    Number.isFinite(awayAttack) &&
    awayAttack > 0
      ? awayAttack
      : 1.05;

  return {
    homeXG: home,
    awayXG: away,
  };
}

function buildMatrix(
  lambdaHome,
  lambdaAway,
  rho = -0.08
) {
  const matrix = [];

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
      let probability =
        poisson(
          homeGoals,
          lambdaHome
        ) *
        poisson(
          awayGoals,
          lambdaAway
        );

      // Dixon-Coles adjustment
      if (
        homeGoals === 0 &&
        awayGoals === 0
      ) {
        probability *=
          1 -
          lambdaHome *
          lambdaAway *
          rho;
      } else if (
        homeGoals === 0 &&
        awayGoals === 1
      ) {
        probability *=
          1 +
          lambdaHome * rho;
      } else if (
        homeGoals === 1 &&
        awayGoals === 0
      ) {
        probability *=
          1 +
          lambdaAway * rho;
      } else if (
        homeGoals === 1 &&
        awayGoals === 1
      ) {
        probability *=
          1 - rho;
      }

      matrix[homeGoals][awayGoals] =
        Math.max(0, probability);
    }
  }

  // Normalizzazione
  let total = 0;

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
      total += matrix[h][a];
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
        matrix[h][a] /=
          total;
      }
    }
  }

  return matrix;
}

function calculateMarkets(matrix) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  let btts = 0;

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
      const probability =
        matrix[h][a];

      // 1X2
      if (h > a) {
        homeWin += probability;
      } else if (h === a) {
        draw += probability;
      } else {
        awayWin += probability;
      }

      // Over
      const totalGoals = h + a;

      if (totalGoals > 1.5) {
        over15 += probability;
      }

      if (totalGoals > 2.5) {
        over25 += probability;
      }

      if (totalGoals > 3.5) {
        over35 += probability;
      }

      // BTTS
      if (h > 0 && a > 0) {
        btts += probability;
      }
    }
  }

  return {
    homeWin,
    draw,
    awayWin,

    doubleChance: {
      "1X":
        homeWin + draw,
      "X2":
        draw + awayWin,
      "12":
        homeWin + awayWin,
    },

    overUnder: {
      "over1.5": over15,
      "under1.5":
        1 - over15,

      "over2.5": over25,
      "under2.5":
        1 - over25,

      "over3.5": over35,
      "under3.5":
        1 - over35,
    },

    btts: {
      yes: btts,
      no: 1 - btts,
    },
  };
}

function getExactScores(matrix) {
  const scores = [];

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
      scores.push({
        score: `${h}-${a}`,
        probability:
          matrix[h][a],
      });
    }
  }

  return scores
    .sort(
      (a, b) =>
        b.probability -
        a.probability
    )
    .slice(0, 10);
}

function toFairOdds(probability) {
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

function calculateFairOdds(markets) {
  return {
    "1":
      toFairOdds(
        markets.homeWin
      ),

    X:
      toFairOdds(
        markets.draw
      ),

    "2":
      toFairOdds(
        markets.awayWin
      ),

    "1X":
      toFairOdds(
        markets.doubleChance["1X"]
      ),

    "X2":
      toFairOdds(
        markets.doubleChance["X2"]
      ),

    "12":
      toFairOdds(
        markets.doubleChance["12"]
      ),

    "Over 1.5":
      toFairOdds(
        markets.overUnder["over1.5"]
      ),

    "Under 1.5":
      toFairOdds(
        markets.overUnder["under1.5"]
      ),

    "Over 2.5":
      toFairOdds(
        markets.overUnder["over2.5"]
      ),

    "Under 2.5":
      toFairOdds(
        markets.overUnder["under2.5"]
      ),

    "Over 3.5":
      toFairOdds(
        markets.overUnder["over3.5"]
      ),

    "Under 3.5":
      toFairOdds(
        markets.overUnder["under3.5"]
      ),

    "BTTS Yes":
      toFairOdds(
        markets.btts.yes
      ),

    "BTTS No":
      toFairOdds(
        markets.btts.no
      ),
  };
}

function calculateConfidence({
  xgSource,
  match,
  lineups,
}) {
  let confidence = 45;

  // xG reale BBS
  if (
    xgSource ===
    "BBD match xG"
  ) {
    confidence += 25;
  }

  // xG/API
  if (
    xgSource ===
    "BBD/API xG"
  ) {
    confidence += 20;
  }

  // Formazioni
  if (
    Array.isArray(lineups) &&
    lineups.length > 0
  ) {
    confidence += 10;
  }

  // Stato partita disponibile
  if (
    match?.status
  ) {
    confidence += 5;
  }

  return Math.max(
    30,
    Math.min(
      90,
      confidence
    )
  );
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error:
        "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const body =
      typeof req.body ===
      "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const homeTeam =
      body.homeTeam;

    const awayTeam =
      body.awayTeam;

    if (
      !homeTeam ||
      !awayTeam
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "MISSING_TEAMS",
        message:
          "homeTeam e awayTeam sono obbligatori.",
      });
    }

    // -------------------------
    // xG
    // -------------------------
    const matchXG =
      getMatchXG(body);

    let xgSource =
      "Fallback model";

    let xg;

    if (matchXG) {
      xg = matchXG;
      xgSource =
        "BBD match xG";
    } else {
      xg =
        getFallbackXG(body);

      if (
        body.homeXG != null ||
        body.awayXG != null
      ) {
        xgSource =
          "BBD/API xG";
      }
    }

    // -------------------------
    // Home advantage
    // -------------------------
    const competition =
      body.competition ||
      "seriea";

    const homeAdvantage =
      competition === "coppa"
        ? 1.08
        : 1.12;

    let lambdaHome =
      xg.homeXG *
      homeAdvantage;

    let lambdaAway =
      xg.awayXG;

    // Protezione valori
    lambdaHome =
      Math.max(
        0.05,
        Math.min(
          6,
          lambdaHome
        )
      );

    lambdaAway =
      Math.max(
        0.05,
        Math.min(
          6,
          lambdaAway
        )
      );

    // -------------------------
    // Dixon-Coles
    // -------------------------
    const matrix =
      buildMatrix(
        lambdaHome,
        lambdaAway,
        -0.08
      );

    // -------------------------
    // Markets
    // -------------------------
    const markets =
      calculateMarkets(
        matrix
      );

    // -------------------------
    // Exact scores
    // -------------------------
    const exactScores =
      getExactScores(
        matrix
      );

    // -------------------------
    // Fair odds
    // -------------------------
    const fairOdds =
      calculateFairOdds(
        markets
      );

    // -------------------------
    // Confidence
    // -------------------------
    const confidence =
      calculateConfidence({
        xgSource,
        match:
          body.match,
        lineups:
          body.match?.lineups,
      });

    return res.status(200).json({
      ok: true,

      model: {
        name:
          "Poisson + Dixon-Coles",
        version:
          "V5",
        rho: -0.08,
        maxGoals:
          MAX_GOALS,
        competition,
        homeAdvantage,
      },

      match: {
        homeTeam,
        awayTeam,
      },

      xgSource,

      expectedGoals: {
        home:
          Number(
            lambdaHome.toFixed(3)
          ),
        away:
          Number(
            lambdaAway.toFixed(3)
          ),
      },

      probabilities: markets,

      exactScores,

      fairOdds,

      confidence,

      generatedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "Predict error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "PREDICT_FAILED",
      message:
        error?.message ||
        "Errore durante la previsione.",
    });
  }
}
