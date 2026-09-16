import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function mapResult(score) {
  if (score.home > score.away) return '1';
  if (score.away > score.home) return '2';
  return 'X';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { storedMatches } = req.body;

  if (!Array.isArray(storedMatches)) {
    return res.status(400).json({ error: 'storedMatches must be an array' });
  }

  try {
    const results = [];

    for (const match of storedMatches) {
      const matchId = match?.id ?? match?.match_id ?? match?.fixture_id;
      const homeTeam = match?.home?.name ?? match?.home_name;
      const awayTeam = match?.away?.name ?? match?.away_name;
      const score = match?.score;

      if (!matchId || !homeTeam || !awayTeam || !score) continue;

      const result1x2 = mapResult(score);

      const { error } = await supabase.from('results').upsert(
        {
          match_id: String(matchId),
          home_team: homeTeam,
          away_team: awayTeam,
          result_1x2: result1x2,
          goals_home: score.home,
          goals_away: score.away,
          finished_at: new Date().toISOString()
        },
        { onConflict: 'match_id' }
      );

      if (!error) {
        results.push({
          match_id: matchId,
          home_team: homeTeam,
          away_team: awayTeam,
          result: result1x2
        });
      }
    }

    return res.status(200).json({
      ok: true,
      message: `${results.length} results saved`,
      results
    });
  } catch (error) {
    console.error('sync-result error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
