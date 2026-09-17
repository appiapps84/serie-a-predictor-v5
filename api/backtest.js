import { getSupabase } from "./lib/supabase.js";

/* =========================================================
   BACKTEST: misura l'accuratezza REALE del modello.
   Confronta le previsioni salvate (Supabase) con i risultati
   caricati dalla sincronizzazione.
========================================================= */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const supabase = getSupabase();

  if (!supabase) {
    return res.status(200).json({
      ok: true,
      stats: null,
      message: "Supabase non configurato: il backtest richiede SUPABASE_URL e SUPABASE_ANON_KEY."
    });
  }

  try {
    const [{ data: predictions, error: pErr }, { data: results, error: rErr }] =
      await Promise.all([
        supabase.from("predictions").select("*").order("predicted_at", { ascending: false }).limit(500),
        supabase.from("results").select("*")
      ]);

    if (pErr) throw pErr;
    if (rErr) throw rErr;

    if (!predictions || predictions.length === 0) {
      return res.status(200).json({
        ok: true,
        stats: null,
        message: "Nessuna previsione salvata ancora. Gioca/usa il predictor e aspetta i risultati."
      });
    }

    // join su match_id
    const resultsById = new Map();
    for (const r of results || []) {
      resultsById.set(String(r.match_id), r);
    }

    const matched = [];
    const unmatched = [];

    for (const p of predictions) {
      const result = resultsById.get(String(p.match_id));
      if (result) {
        matched.push({ prediction: p, result });
      } else {
        unmatched.push(p);
      }
    }

    if (matched.length === 0) {
      return res.status(200).json({
        ok: true,
        stats: null,
        message: `${predictions.length} previsioni salvate ma nessuna partita ancora conclusa: riprova dopo i prossimi risultati.`,
        pending: predictions.length
      });
    }

    const correct = matched.filter(
      (m) => m.prediction.prediction_1x2 === m.result.result_1x2
    ).length;

    const recent20 = matched.slice(0, 20);
    const recentCorrect = recent20.filter(
      (m) => m.prediction.prediction_1x2 === m.result.result_1x2
    ).length;

    // MAE sui gol totali (xG stimati vs gol reali)
    const mae =
      matched.reduce((sum, m) => {
        const predGoals = (Number(m.prediction.xg_home) || 0) + (Number(m.prediction.xg_away) || 0);
        const realGoals = (Number(m.result.goals_home) || 0) + (Number(m.result.goals_away) || 0);
        return sum + Math.abs(predGoals - realGoals);
      }, 0) / matched.length;

    // Brier score sul 1X2 (quanto le probabilita' sono "sicure di se" = calibrazione)
    const brier =
      matched.reduce((sum, m) => {
        const p = m.prediction.probabilities || {};
        const ph = Number(p.home) || 0;
        const pd = Number(p.draw) || 0;
        const pa = Number(p.away) || 0;

        const oh = m.result.result_1x2 === "1" ? 1 : 0;
        const od = m.result.result_1x2 === "X" ? 1 : 0;
        const oa = m.result.result_1x2 === "2" ? 1 : 0;

        return sum + (Math.pow(ph - oh, 2) + Math.pow(pd - od, 2) + Math.pow(pa - oa, 2)) / 2;
      }, 0) / matched.length;

    // distribuzione esiti per vedere se il modello e' equilibrato
    const pickCounts = { "1": 0, "X": 0, "2": 0 };
    const resultCounts = { "1": 0, "X": 0, "2": 0 };

    for (const m of matched) {
      pickCounts[m.prediction.prediction_1x2] =
        (pickCounts[m.prediction.prediction_1x2] || 0) + 1;
      resultCounts[m.result.result_1x2] =
        (resultCounts[m.result.result_1x2] || 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      stats: {
        totalPredictions: predictions.length,
        totalMatched: matched.length,
        pending: unmatched.length,

        accuracy1X2: Number(((correct / matched.length) * 100).toFixed(1)),
        correct,

        recent20: {
          sample: recent20.length,
          correct: recentCorrect,
          accuracy: Number(((recentCorrect / Math.max(1, recent20.length)) * 100).toFixed(1))
        },

        maeTotalGoals: Number(mae.toFixed(2)),
        brierScore: Number(brier.toFixed(3)),

        picks: pickCounts,
        actualResults: resultCounts
      },

      lastMatches: matched.slice(0, 10).map((m) => ({
        match: `${m.prediction.home_team} - ${m.prediction.away_team}`,
        predicted: m.prediction.prediction_1x2,
        result: `${m.result.goals_home}-${m.result.goals_away}`,
        hit: m.prediction.prediction_1x2 === m.result.result_1x2,
        date: m.result.finished_at
      }))
    });

  } catch (error) {
    console.error("BACKTEST ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "BACKTEST_ERROR",
      message: error?.message || String(error)
    });
  }
}
