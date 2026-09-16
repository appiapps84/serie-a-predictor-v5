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


function normalizeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function normalizeXG(value) {
  const n = normalizeNumber(value);

  if (n === null) {
    return null;
  }

  if (n < 0 || n > 10) {
    return null;
  }

  return n;
}


/*
 * Cerca xG diretti.
 */
function getDirectXG(body) {

  const matchXG =
    body?.match?.xG ||
    body?.match?.xg ||
    body?.xG ||
    body?.xg;


  if (matchXG) {

    const home =
      normalizeXG(
        matchXG.homeXG ??
        matchXG.home ??
        matchXG.home_xg ??
        matchXG.home_xG
      );


    const away =
      normalizeXG(
        matchXG.awayXG ??
        matchXG.away ??
        matchXG.away_xg ??
        matchXG.away_xG
      );


    if (
      home !== null &&
      away !== null
    ) {

      return {
        homeXG: home,
        awayXG: away,
        source: "BBD match xG"
      };

    }

  }


  const rootHome =
    normalizeXG(
      body?.homeXG ??
      body?.home_xg
    );


  const rootAway =
    normalizeXG(
      body?.awayXG ??
      body?.away_xg
    );


  if (
    rootHome !== null &&
    rootAway !== null
  ) {

    return {
      homeXG: rootHome,
      awayXG: rootAway,
      source: "BBD/API xG"
    };

  }


  return null;
}


/*
 * Estima xG usando la classifica.
 *
 * ATTENZIONE:
 * questa NON è una statistica xG ufficiale BBD.
 * È una stima del modello basata sui gol fatti/subiti.
 */
function getStandingsEstimate(
  standings,
  homeTeam,
  awayTeam
) {

  if (!Array.isArray(standings)) {
    return null;
  }


  function teamName(row) {

    return String(
      row?.team_name ??
      row?.teamName ??
      row?.name ??
      row?.team?.name ??
      ""
    )
      .trim()
      .toLowerCase();

  }


  function findTeam(name) {

    const wanted =
      String(name || "")
        .trim()
        .toLowerCase();


    return standings.find(
      row => {

        const current =
          teamName(row);

        return (
          current === wanted ||
          current.includes(wanted) ||
          wanted.includes(current)
        );

      }
    ) || null;

  }


  const home =
    findTeam(homeTeam);

  const away =
    findTeam(awayTeam);


  if (!home || !away) {
    return null;
  }


  const homeGames =
    Number(
      home.games_played ??
      home.played ??
      home.games ??
      0
    );


  const awayGames =
    Number(
      away.games_played ??
      away.played ??
      away.games ??
      0
    );


  if (
    homeGames <= 0 ||
    awayGames <= 0
  ) {
    return null;
  }


  const homeGF =
    Number(
      home.points_for ??
      home.goals_for ??
      home.gf ??
      0
    );


  const homeGA =
    Number(
      home.points_against ??
      home.goals_against ??
      home.ga ??
      0
    );


  const awayGF =
    Number(
      away.points_for ??
      away.goals_for ??
      away.gf ??
      0
    );


  const awayGA =
    Number(
      away.points_against ??
      away.goals_against ??
      away.ga ??
      0
    );


  if (
    ![
      homeGF,
      homeGA,
      awayGF,
      awayGA
    ].every(Number.isFinite)
  ) {

    return null;

  }


  /*
   * Medie gol.
   */
  const homeAttack =
    homeGF / homeGames;

  const homeDefense =
    homeGA / homeGames;

  const awayAttack =
    awayGF / awayGames;

  const awayDefense =
    awayGA / awayGames;


  /*
   * Valori di riferimento Serie A.
   */
  const leagueHomeGoals = 1.45;
  const leagueAwayGoals = 1.15;


  let homeXG =
    leagueHomeGoals *
    (
      0.60 *
      (homeAttack / leagueHomeGoals)
      +
      0.40 *
      (awayDefense / leagueHomeGoals)
    );


  let awayXG =
    leagueAwayGoals *
    (
      0.60 *
      (awayAttack / leagueAwayGoals)
      +
      0.40 *
      (homeDefense / leagueAwayGoals)
    );


  /*
   * Vantaggio campo.
   */
  homeXG *= 1.06;


  /*
   * Limiti di sicurezza.
   */
  homeXG =
    Math.max(
      0.15,
      Math.min(4.5, homeXG)
    );


  awayXG =
    Math.max(
      0.10,
      Math.min(4.0, awayXG)
    );


  return {
    homeXG,
    awayXG,
    source: "Stima da classifica"
  };

}


/*
 * Fallback.
 */
function getFallbackXG() {

  return {
    homeXG: 1.35,
    awayXG: 1.05,
    source: "Fallback model"
  };

}


/*
 * Dixon-Coles adjustment.
 */
function dixonColesAdjustment(
  homeGoals,
  awayGoals,
  homeLambda,
  awayLambda
) {

  const rho =
    DIXON_COLES_RHO;


  if (
    homeGoals === 0 &&
    awayGoals === 0
  ) {

    return (
      1 -
      homeLambda *
      awayLambda *
      rho
    );

  }


  if (
    homeGoals === 0 &&
    awayGoals === 1
  ) {

    return (
      1 +
      homeLambda *
      rho
    );

  }


  if (
    homeGoals === 1 &&
    awayGoals === 0
  ) {

    return (
      1 +
      awayLambda *
      rho
    );

  }


  if (
    homeGoals === 1 &&
    awayGoals === 1
  ) {

    return (
      1 -
      rho
    );

  }


  return 1;

}


/*
 * Costruisce matrice risultati.
 */
function buildMatrix(
  homeXG,
  awayXG
) {

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
        poisson(
          homeGoals,
          homeXG
        ) *
        poisson(
          awayGoals,
          awayXG
        );


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


  /*
   * Normalizzazione.
   */
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


/*
 * Calcola 1X2.
 */
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
      }

      else if (h === a) {
        draw += p;
      }

      else {
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


/*
 * Over / Under.
 */
function calculateOverUnder(
  matrix
) {

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


/*
 * BTTS.
 */
function calculateBTTS(
  matrix
) {

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


      if (
        h > 0 &&
        a > 0
      ) {

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


/*
 * Doppia chance.
 */
function calculateDoubleChance(
  probabilities
) {

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


/*
 * Risultati esatti.
 */
function calculateExactScores(
  matrix
) {

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

        score:
          `${h}-${a}`,

        home:
          h,

        away:
          a,

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


/*
 * Quote fair.
 */
function fairOdd(probability) {

  if (
    !Number.isFinite(probability) ||
    probability <= 0
  ) {

    return null;

  }


  return Number(
    (1 / probability)
      .toFixed(2)
  );

}


/*
 * Confidenza.
 */
function calculateConfidence(
  source
) {

  let confidence = 55;


  if (
    source === "BBD match xG"
  ) {

    confidence = 80;

  }

  else if (
    source === "BBD/API xG"
  ) {

    confidence = 75;

  }

  else if (
    source === "Stima da classifica"
  ) {

    confidence = 65;

  }

  else {

    confidence = 55;

  }


  return confidence;

}


/*
 * PARSE BODY
 */
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

      return JSON.parse(
        req.body
      );

    } catch {

      return {};

    }

  }


  return {};

}


/*
 * HANDLER
 */
export default async function handler(
  req,
  res
) {

  res.setHeader(
    "Cache-Control",
    "no-store"
  );


  if (
    req.method !== "POST"
  ) {

    return res
      .status(405)
      .json({

        ok: false,

        error:
          "METHOD_NOT_ALLOWED",

        message:
          "Usa POST per /api/predict."

      });

  }


  try {

    const body =
      await parseBody(req);


    const homeTeam =
      String(
        body.homeTeam ||
        ""
      ).trim();


    const awayTeam =
      String(
        body.awayTeam ||
        ""
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

      return res
        .status(400)
        .json({

          ok: false,

          error:
            "MISSING_TEAMS",

          message:
            "homeTeam e awayTeam sono obbligatori."

        });

    }


    /*
     * 1. xG diretti.
     */
    let xg =
      getDirectXG(body);


    /*
     * 2. xG da classifica.
     */
    if (!xg) {

      xg =
        getStandingsEstimate(
          body.standings,
          homeTeam,
          awayTeam
        );

    }


    /*
     * 3. fallback.
     */
    if (!xg) {

      xg =
        getFallbackXG();

    }


    const homeXG =
      xg.homeXG;


    const awayXG =
      xg.awayXG;


    /*
     * Matrice.
     */
    const matrix =
      buildMatrix(
        homeXG,
        awayXG
      );


    /*
     * 1X2.
     */
    const probabilities =
      calculate1X2(
        matrix
      );


    /*
     * Doppia chance.
     */
    const doubleChance =
      calculateDoubleChance(
        probabilities
      );


    /*
     * Over / Under.
     */
    const overUnder =
      calculateOverUnder(
        matrix
      );


    /*
     * BTTS.
     */
    const btts =
      calculateBTTS(
        matrix
      );


    /*
     * Risultati esatti.
     */
    const exactScores =
      calculateExactScores(
        matrix
      );


    /*
     * Quote fair 1X2.
     */
    const fairOdds = {

      home:
        fairOdd(
          probabilities.home
        ),

      draw:
        fairOdd(
          probabilities.draw
        ),

      away:
        fairOdd(
          probabilities.away
        )

    };


    /*
     * Confidenza.
     */
    const confidence =
      calculateConfidence(
        xg.source
      );


    /*
     * Risposta standardizzata.
     *
     * Tutti i nomi usati dal frontend
     * sono presenti qui.
     */
    return res
      .status(200)
      .json({

        ok: true,

        competition,

        homeTeam,

        awayTeam,

        model:
          "Poisson + Dixon-Coles",

        xgSource:
          xg.source,

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

        exactScores,

        fairOdds,

        confidence

      });


  } catch (error) {

    console.error(
      "PREDICT ERROR:",
      error
    );


    return res
      .status(500)
      .json({

        ok: false,

        error:
          "PREDICTION_ERROR",

        message:
          error?.message ||
          "Errore interno nel modello."

      });

  }

}
