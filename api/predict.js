const MAX_GOALS = 10;

/*
  V5 Predictor

  - Poisson
  - Dixon-Coles
  - xG quando disponibile
  - fallback rating quando xG match-level non è disponibile
  - home advantage
  - recency/quality modifiers quando presenti
*/

function send(res, status, data) {

  res.status(status);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  return res.json(data);

}

function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}

function poisson(k, lambda) {

  if (lambda <= 0) {
    return k === 0 ? 1 : 0;
  }

  let factorial = 1;

  for (
    let i = 2;
    i <= k;
    i++
  ) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial
  );

}

function normalizeXG(value) {

  const n =
    Number(value);

  if (
    !Number.isFinite(n) ||
    n < 0
  ) {
    return null;
  }

  return n;

}

function getMatchXG(body) {

  if (
    body.match?.xG
  ) {

    const home =
      normalizeXG(
        body.match.xG.homeXG
      );

    const away =
      normalizeXG(
        body.match.xG.awayXG
      );

    if (
      home !== null &&
      away !== null
    ) {

      return {
        home,
        away,
        source:
          "BBD match xG"
      };

    }

  }

  const home =
    normalizeXG(
      body.homeXG
    );

  const away =
    normalizeXG(
      body.awayXG
    );

  if (
    home !== null &&
    away !== null
  ) {

    return {
      home,
      away,
      source:
        "BBD/API xG"
    };

  }

  return null;

}

function getFallbackXG(body) {

  /*
    Fallback prudente.

    NON usiamo più i vecchi valori arbitrari
    del frontend.

    Se non c'è xG della singola partita,
    utilizziamo una stima neutra iniziale.
    Il modello diventerà progressivamente più
    informativo quando saranno disponibili
    gli xG storici nel database.
  */

  const homeStrength =
    Number(
      body.homeAttack
    );

  const awayStrength =
    Number(
      body.awayAttack
    );

  const validHome =
    Number.isFinite(
      homeStrength
    );

  const validAway =
    Number.isFinite(
      awayStrength
    );

  let home =
    validHome
      ? homeStrength
      : 1.35;

  let away =
    validAway
      ? awayStrength
      : 1.05;

  return {
    home:
      clamp(
        home,
        0.25,
        3.5
      ),

    away:
      clamp(
        away,
        0.20,
        3.0
      ),

    source:
      "V5 fallback"
  };

}

function buildMatrix(
  lambdaHome,
  lambdaAway,
  rho
) {

  const matrix = [];

  let total = 0;

  for (
    let h = 0;
    h <= MAX_GOALS;
    h++
  ) {

    matrix[h] = [];

    for (
      let a = 0;
      a <= MAX_GOALS;
      a++
    ) {

      let p =
        poisson(
          h,
          lambdaHome
        ) *
        poisson(
          a,
          lambdaAway
        );

      /*
        Dixon-Coles correction
        per i quattro risultati
        a bassa frequenza.
      */

      let tau = 1;

      if (
        h === 0 &&
        a === 0
      ) {

        tau =
          1 -
          lambdaHome *
          lambdaAway *
          rho;

      } else if (
        h === 0 &&
        a === 1
      ) {

        tau =
          1 +
          lambdaHome *
          rho;

      } else if (
        h === 1 &&
        a === 0
      ) {

        tau =
          1 +
          lambdaAway *
          rho;

      } else if (
        h === 1 &&
        a === 1
      ) {

        tau =
          1 -
          rho;

      }

      p *=
        Math.max(
          0,
          tau
        );

      matrix[h][a] =
        p;

      total += p;

    }

  }

  /*
    Normalizzazione.
    Necessaria perché la matrice è troncata
    a 10 gol.
  */

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

  return matrix;

}

function calculateMarkets(matrix) {

  let home = 0;
  let draw = 0;
  let away = 0;

  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  let btts = 0;

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

      const p =
        matrix[h][a];

      const goals =
        h + a;

      if (h > a) {
        home += p;
      }

      else if (h === a) {
        draw += p;
      }

      else {
        away += p;
      }

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
        h > 0 &&
        a > 0
      ) {
        btts += p;
      }

      scores.push({
        homeGoals: h,
        awayGoals: a,
        probability: p
      });

    }

  }

  scores.sort(
    (a, b) =>
      b.probability -
      a.probability
  );

  return {

    home,
    draw,
    away,

    oneX:
      home + draw,

    xTwo:
      draw + away,

    oneTwo:
      home + away,

    over15,

    under15:
      1 - over15,

    over25,

    under25:
      1 - over25,

    over35,

    under35:
      1 - over35,

    bttsYes:
      btts,

    bttsNo:
      1 - btts,

    scores

  };

}

function calculateConfidence(
  body,
  xgSource
) {

  let score = 45;

  if (
    xgSource === "BBD match xG"
  ) {
    score += 25;
  }

  else if (
    xgSource === "BBD/API xG"
  ) {
    score += 20;
  }

  if (
    body.match?.lineups?.available
  ) {
    score += 10;
  }

  if (
    body.match?.status
  ) {
    score += 5;
  }

  return clamp(
    score,
    30,
    90
  );

}

export default async function handler(
  req,
  res
) {

  if (
    req.method !== "POST"
  ) {

    return send(
      res,
      405,
      {
        error:
          "METHOD_NOT_ALLOWED"
      }
    );

  }

  try {

    const body =
      req.body || {};

    const homeTeam =
      body.homeTeam;

    const awayTeam =
      body.awayTeam;

    if (
      !homeTeam ||
      !awayTeam
    ) {

      return send(
        res,
        400,
        {
          error:
            "TEAMS_REQUIRED"
        }
      );

    }

    if (
      homeTeam === awayTeam
    ) {

      return send(
        res,
        400,
        {
          error:
            "SAME_TEAM"
        }
      );

    }

    /*
      1. xG reale BBD
    */

    const xg =
      getMatchXG(
        body
      );

    /*
      2. fallback
    */

    const fallback =
      getFallbackXG(
        body
      );

    /*
      3. home advantage
    */

    const homeAdvantage =
      body.competition === "coppa"
        ? 1.08
        : 1.12;

    let lambdaHome;
    let lambdaAway;
    let xgSource;

    if (xg) {

      lambdaHome =
        xg.home *
        homeAdvantage;

      lambdaAway =
        xg.away;

      xgSource =
        xg.source;

    } else {

      lambdaHome =
        fallback.home *
        homeAdvantage;

      lambdaAway =
        fallback.away;

      xgSource =
        fallback.source;

    }

    /*
      Evitiamo valori assurdi.
    */

    lambdaHome =
      clamp(
        lambdaHome,
        0.10,
        5.0
      );

    lambdaAway =
      clamp(
        lambdaAway,
        0.10,
        5.0
      );

    /*
      Dixon-Coles rho.

      Valore iniziale prudente.
      Verrà calibrato realmente nel
      modulo storico/backtesting.
    */

    const rho =
      -0.08;

    const matrix =
      buildMatrix(
        lambdaHome,
        lambdaAway,
        rho
      );

    const markets =
      calculateMarkets(
        matrix
      );

    const confidence =
      calculateConfidence(
        body,
        xgSource
      );

    /*
      Coppa:
      NON fingiamo che il pareggio 90'
      equivalga automaticamente ai rigori.

      Per ora riportiamo solo la probabilità
      dei 90 minuti. La qualificazione verrà
      implementata con simulazione 120' + rigori
      quando la parte Coppa sarà collegata
      al calendario completo.
    */

    return send(
      res,
      200,
      {

        ok: true,

        model:
          "V5-Poisson-Dixon-Coles",

        xgSource,

        teams: {
          home:
            homeTeam,

          away:
            awayTeam
        },

        expectedGoals: {

          home:
            lambdaHome,

          away:
            lambdaAway,

          total:
            lambdaHome +
            lambdaAway

        },

        probabilities: {

          home:
            markets.home,

          draw:
            markets.draw,

          away:
            markets.away,

          oneX:
            markets.oneX,

          xTwo:
            markets.xTwo,

          oneTwo:
            markets.oneTwo,

          over15:
            markets.over15,

          under15:
            markets.under15,

          over25:
            markets.over25,

          under25:
            markets.under25,

          over35:
            markets.over35,

          under35:
            markets.under35,

          bttsYes:
            markets.bttsYes,

          bttsNo:
            markets.bttsNo

        },

        exactScores:
          markets.scores.slice(
            0,
            10
          ),

        fairOdds: {

          home:
            1 /
            markets.home,

          draw:
            1 /
            markets.draw,

          away:
            1 /
            markets.away

        },

        confidence,

        generatedAt:
          new Date().toISOString()

      }
    );

  } catch (error) {

    console.error(
      "PREDICT ERROR",
      error
    );

    return send(
      res,
      500,
      {

        ok: false,

        error:
          "PREDICTION_FAILED",

        message:
          error.message

      }
    );

  }

}
