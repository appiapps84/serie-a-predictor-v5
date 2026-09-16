const MAX_GOALS = 10;
const DIXON_COLES_RHO = -0.08;

/* =========================================================
   POISSON
========================================================= */

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


/* =========================================================
   NORMALIZZAZIONE
========================================================= */

function normalizeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}


function normalizeXG(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  if (n < 0 || n > 10) {
    return null;
  }

  return n;
}


/* =========================================================
   INPUT xG DIRETTO
========================================================= */

function getMatchXG(body) {

  const matchXG =
    body?.match?.xG;

  if (matchXG) {

    const home =
      normalizeXG(
        matchXG.homeXG ??
        matchXG.home ??
        matchXG.home_xg
      );

    const away =
      normalizeXG(
        matchXG.awayXG ??
        matchXG.away ??
        matchXG.away_xg
      );

    if (
      home !== null &&
      away !== null
    ) {
      return {
        homeXG: home,
        awayXG: away
      };
    }
  }


  const home =
    normalizeXG(
      body?.homeXG ??
      body?.home_xg
    );

  const away =
    normalizeXG(
      body?.awayXG ??
      body?.away_xg
    );


  if (
    home !== null &&
    away !== null
  ) {
    return {
      homeXG: home,
      awayXG: away
    };
  }


  return null;
}


/* =========================================================
   FALLBACK BASE
========================================================= */

function getFallbackXG(body) {

  const homeAttack =
    Number(body?.homeAttack);

  const awayAttack =
    Number(body?.awayAttack);


  return {

    homeXG:
      Number.isFinite(homeAttack) &&
      homeAttack > 0
        ? Math.min(homeAttack, 6)
        : 1.35,

    awayXG:
      Number.isFinite(awayAttack) &&
      awayAttack > 0
        ? Math.min(awayAttack, 6)
        : 1.05
  };
}


/* =========================================================
   xG DA CLASSIFICA
========================================================= */

function getStandingsXG(body) {

  const standings =
    Array.isArray(body?.standings)
      ? body.standings
      : [];


  if (standings.length < 2) {
    return null;
  }


  const homeTeam =
    String(
      body?.homeTeam || ""
    ).trim().toLowerCase();


  const awayTeam =
    String(
      body?.awayTeam || ""
    ).trim().toLowerCase();


  function findTeam(name) {

    const target =
      name.toLowerCase();


    return standings.find(row => {

      const rowName =
        String(
          row?.team_name ??
          row?.name ??
          row?.team?.name ??
          ""
        )
        .trim()
        .toLowerCase();


      return (
        rowName === target ||
        rowName.includes(target) ||
        target.includes(rowName)
      );
    });
  }


  const home =
    findTeam(homeTeam);

  const away =
    findTeam(awayTeam);


  if (!home || !away) {
    return null;
  }


  /*
   * Usiamo:
   *
   * punti per partita
   * +
   * differenziale reti per partita
   *
   * per ottenere un indice offensivo/forza.
   */


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


  const homePF =
    Number(
      home.points_for ??
      home.goals_for ??
      home.gf ??
      0
    );


  const homePA =
    Number(
      home.points_against ??
      home.goals_against ??
      home.ga ??
      0
    );


  const awayPF =
    Number(
      away.points_for ??
      away.goals_for ??
      away.gf ??
      0
    );


  const awayPA =
    Number(
      away.points_against ??
      away.goals_against ??
      away.ga ??
      0
    );


  if (
    homeGames <= 0 ||
    awayGames <= 0
  ) {
    return null;
  }


  const homeGF =
    homePF / homeGames;

  const homeGA =
    homePA / homeGames;

  const awayGF =
    awayPF / awayGames;

  const awayGA =
    awayPA / awayGames;


  /*
   * Base campionato.
   */

  const leagueHome =
    1.55;

  const leagueAway =
    1.20;


  /*
   * Forza offensiva + vulnerabilità difensiva.
   */

  let homeXG =
    leagueHome *
    (
      0.65 * (homeGF / 1.45) +
      0.35 * (awayGA / 1.20)
    );


  let awayXG =
    leagueAway *
    (
      0.65 * (awayGF / 1.45) +
      0.35 * (homeGA / 1.55)
    );


  /*
   * Limiti realistici.
   */

  homeXG =
    Math.max(
      0.35,
      Math.min(3.8, homeXG)
    );


  awayXG =
    Math.max(
      0.25,
      Math.min(3.5, awayXG)
    );


  /*
   * Vantaggio campo.
   */

  homeXG *= 1.06;


  return {
    homeXG,
    awayXG
  };
}


/* =========================================================
   DIXON-COLES
========================================================= */

function dixonColesAdjustment(
  homeGoals,
  awayGoals,
  homeXG,
  awayXG
) {

  const rho =
    DIXON_COLES_RHO;


  if (
    homeGoals === 0 &&
    awayGoals === 0
  ) {
    return (
      1 -
      homeXG *
      awayXG *
      rho
    );
  }


  if (
    homeGoals === 0 &&
    awayGoals === 1
  ) {
    return (
      1 +
      homeXG *
      rho
    );
  }


  if (
    homeGoals === 1 &&
    awayGoals === 0
  ) {
    return (
      1 +
      awayXG *
      rho
    );
  }


  if (
    homeGoals === 1 &&
    awayGoals === 1
  ) {
    return 1 - rho;
  }


  return 1;
}


/* =========================================================
   MATRICE PROBABILITÀ
========================================================= */

function buildScoreMatrix(
  homeXG,
  awayXG
) {

  const matrix = [];

  let total = 0;


  for (
    let home = 0;
    home <= MAX_GOALS;
    home++
  ) {

    matrix[home] = [];

    for (
      let away = 0;
      away <= MAX_GOALS;
      away++
    ) {

      const base =
        poisson(home, homeXG) *
        poisson(away, awayXG);


      const adjustment =
        dixonColesAdjustment(
          home,
          away,
          homeXG,
          awayXG
        );


      const probability =
        base * adjustment;


      matrix[home][away] =
        probability;


      total += probability;
    }
  }


  /*
   * Normalizzazione.
   */

  for (
    let home = 0;
    home <= MAX_GOALS;
    home++
  ) {

    for (
      let away = 0;
      away <= MAX_GOALS;
      away++
    ) {

      matrix[home][away] =
        matrix[home][away] /
        total;
    }
  }


  return matrix;
}


/* =========================================================
   PROBABILITÀ MERCATI
========================================================= */

function calculateProbabilities(
  matrix
) {

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  let bttsYes = 0;


  for (
    let home = 0;
    home <= MAX_GOALS;
    home++
  ) {

    for (
      let away = 0;
      away <= MAX_GOALS;
      away++
    ) {

      const p =
        matrix[home][away];


      if (home > away) {
        homeWin += p;
      }

      else if (home === away) {
        draw += p;
      }

      else {
        awayWin += p;
      }


      const goals =
        home + away;


      if (goals >= 2) {
        over15 += p;
      }

      if (goals >= 3) {
        over25 += p;
      }

      if (goals >= 4) {
        over35 += p;
      }


      if (
        home > 0 &&
        away > 0
      ) {
        bttsYes += p;
      }
    }
  }


  return {

    homeWin,

    draw,

    awayWin,

    homeOrDraw:
      homeWin + draw,

    drawOrAway:
      draw + awayWin,

    homeOrAway:
      homeWin + awayWin,

    over15,

    under15:
      1 - over15,

    over25,

    under25:
      1 - over25,

    over35,

    under35:
      1 - over35,

    bttsYes,

    bttsNo:
      1 - bttsYes
  };
}


/* =========================================================
   RISULTATI ESATTI
========================================================= */

function getExactScores(matrix) {

  const scores = [];


  for (
    let home = 0;
    home <= MAX_GOALS;
    home++
  ) {

    for (
      let away = 0;
      away <= MAX_GOALS;
      away++
    ) {

      scores.push({

        home,

        away,

        probability:
          matrix[home][away]
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


/* =========================================================
   FAIR ODDS
========================================================= */

function fairOdds(probabilities) {

  function odds(p) {

    if (
      !Number.isFinite(p) ||
      p <= 0
    ) {
      return null;
    }

    return Number(
      (1 / p).toFixed(2)
    );
  }


  return {

    homeWin:
      odds(probabilities.homeWin),

    draw:
      odds(probabilities.draw),

    awayWin:
      odds(probabilities.awayWin),

    homeOrDraw:
      odds(probabilities.homeOrDraw),

    drawOrAway:
      odds(probabilities.drawOrAway),

    homeOrAway:
      odds(probabilities.homeOrAway),

    over15:
      odds(probabilities.over15),

    under15:
      odds(probabilities.under15),

    over25:
      odds(probabilities.over25),

    under25:
      odds(probabilities.under25),

    over35:
      odds(probabilities.over35),

    under35:
      odds(probabilities.under35),

    bttsYes:
      odds(probabilities.bttsYes),

    bttsNo:
      odds(probabilities.bttsNo)
  };
}


/* =========================================================
   CONFIDENCE
========================================================= */

function calculateConfidence({
  xgSource,
  match,
  lineups
}) {

  let confidence = 45;


  if (
    xgSource ===
    "BBD match xG"
  ) {
    confidence += 25;
  }


  else if (
    xgSource ===
    "BBD/API xG"
  ) {
    confidence += 20;
  }


  else if (
    xgSource ===
    "BBD standings estimate"
  ) {
    confidence += 10;
  }


  if (
    Array.isArray(lineups) &&
    lineups.length > 0
  ) {
    confidence += 10;
  }


  if (match?.status) {
    confidence += 5;
  }


  return Math.max(
    30,
    Math.min(90, confidence)
  );
}


/* =========================================================
   BODY PARSER
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
      throw new Error(
        "Body JSON non valido."
      );
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
      body.homeTeam ||
      body.home ||
      body.match?.homeTeam ||
      body.match?.home?.name ||
      "Casa";


    const awayTeam =
      body.awayTeam ||
      body.away ||
      body.match?.awayTeam ||
      body.match?.away?.name ||
      "Trasferta";


    const competition =
      body.competition ||
      "seriea";


    /*
     * -----------------------------------------------------
     * 1. PRIORITÀ: xG REALI DEL MATCH
     * -----------------------------------------------------
     */

    let xg =
      getMatchXG(body);


    let xgSource =
      "Fallback model";


    /*
     * -----------------------------------------------------
     * 2. xG API DIRETTI
     * -----------------------------------------------------
     */

    if (!xg) {

      const apiHome =
        normalizeXG(
          body.homeXG
        );

      const apiAway =
        normalizeXG(
          body.awayXG
        );


      if (
        apiHome !== null &&
        apiAway !== null
      ) {

        xg = {

          homeXG:
            apiHome,

          awayXG:
            apiAway
        };


        xgSource =
          "BBD/API xG";
      }
    }


    /*
     * -----------------------------------------------------
     * 3. STIMA DALLA CLASSIFICA
     * -----------------------------------------------------
     */

    if (!xg) {

      const standingsXG =
        getStandingsXG(body);


      if (standingsXG) {

        xg =
          standingsXG;

        xgSource =
          "BBD standings estimate";
      }
    }


    /*
     * -----------------------------------------------------
     * 4. FALLBACK
     * -----------------------------------------------------
     */

    if (!xg) {

      xg =
        getFallbackXG(body);

      xgSource =
        "Fallback model";
    }


    /*
     * Piccola protezione finale.
     */

    let homeXG =
      Math.max(
        0.15,
        Math.min(
          5,
          Number(xg.homeXG)
        )
      );


    let awayXG =
      Math.max(
        0.15,
        Math.min(
          5,
          Number(xg.awayXG)
        )
      );


    /*
     * -----------------------------------------------------
     * MATRICE
     * -----------------------------------------------------
     */

    const matrix =
      buildScoreMatrix(
        homeXG,
        awayXG
      );


    const probabilities =
      calculateProbabilities(
        matrix
      );


    const exactScores =
      getExactScores(
        matrix
      );


    const odds =
      fairOdds(
        probabilities
      );


    const confidence =
      calculateConfidence({
        xgSource,
        match: body.match,
        lineups: body.lineups
      });


    /*
     * -----------------------------------------------------
     * RISPOSTA
     * -----------------------------------------------------
     */

    return res.status(200).json({

      ok: true,

      competition,

      match: {

        homeTeam,

        awayTeam,

        id:
          body.match?.id ??
          null,

        kickoff:
          body.match?.kickoff ??
          null,

        status:
          body.match?.status ??
          null
      },


      xgSource,


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
            homeXG.toFixed(3)
          ),

        away:
          Number(
            awayXG.toFixed(3)
          )
      },


      probabilities,


      exactScores,


      fairOdds:
        odds,


      confidence,


      model: {

        name:
          "Poisson + Dixon-Coles",

        maxGoals:
          MAX_GOALS,

        rho:
          DIXON_COLES_RHO
      }

    });

  } catch (error) {

    console.error(
      "Predict error:",
      error
    );


    return res.status(500).json({

      ok: false,

      error:
        "PREDICTION_ERROR",

      message:
        error?.message ||
        "Errore durante il calcolo della previsione."
    });
  }
}
