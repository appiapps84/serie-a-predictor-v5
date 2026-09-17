import { getSupabase } from "./lib/supabase.js";

/* =========================================================
   SYNC-RESULT: salva i risultati delle partite concluse.
   Usato come endpoint autonomo (chiamato da /api/sync).
   Client Supabase "lazy": senza env var risponde 503, non 500.
========================================================= */

function mapResult(score) {
  if (score.home > score.away) return "1";
  if (score.away > score.home) return "2";
  return "X";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const supabase = getSupabase();

  if (!supabase) {
    return res.status(503).json({
      ok: false,
      error: "SUPABASE_NOT_CONFIGURED",
      message: "Imposta SUPABASE_URL e SUPABASE_ANON_KEY su Vercel per salvare i risultati."
    });
  }

  const { storedMatches } = req.body || {};

  if (!Array.isArray(storedMatches)) {
    return res.status(400).json({ ok: false, error: "storedMatches must be an array" });
  }

  const rows = [];

  for (const match of storedMatches) {
    const matchId = match?.id ?? match?.match_id ?? match?.fixture_id;
    const homeTeam = match?.home?.name ?? match?.home_name ?? match?.homeTeam;
    const awayTeam = match?.away?.name ?? match?.away_name ?? match?.awayTeam;
    const score = match?.score;

    if (!matchId || !homeTeam || !awayTeam || !score) continue;
    if (!Number.isFinite(Number(score.home)) || !Number.isFinite(Number(score.away))) continue;

    rows.push({
      match_id: String(matchId),
      home_team: homeTeam,
      away_team: awayTeam,
      result_1x2: mapResult(score),
      goals_home: Number(score.home),
      goals_away: Number(score.away),
      finished_at: match?.kickoff_utc ?? match?.date ?? new Date().toISOString()
    });
  }

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, message: "0 results to save", saved: 0 });
  }

  let saved = 0;

  try {
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { error } = await supabase.from("results").upsert(chunk, { onConflict: "match_id" });

      if (error) throw error;
      saved += chunk.length;
    }

    return res.status(200).json({ ok: true, message: `${saved} results saved`, saved });
  } catch (error) {
    console.error("sync-result error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
      saved
    });
  }
}
