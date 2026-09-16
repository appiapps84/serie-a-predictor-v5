import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

function mapResult(score: any): string {
  if (score.home > score.away) return '1';
  if (score.away > score.home) return '2';
  return 'X';
}

export default async function handler(req: any, res: any) {
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
      // Estrai info base
      const matchId = match?.id ?? match?.match_id ?? match?.fixture_id;
      const homeTeam = match?.home?.name ?? match?.home_name;
      const awayTeam = match?.away?.name ?? match?.away_name;
      const score = match?.score;

      // Salta se incomplete
      if (!matchId || !homeTeam || !awayTeam || !score) continue;

      const result1x2 = mapResult(score);

      // Salva su Supabase
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

      if (error) {
        console.error(`Error saving result for match ${matchId}:`, error);
      } else {
        results.push({
          match_id: matchId,
          home_team: homeTeam,
          away_team: awayTeam,
          result: result1x2
        });
      }
    }

    // Triggerai calibrazione (asincrono, non blocca)
    fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/calibrate`, {
      method: 'POST'
    }).catch(err => console.error('Calibrate trigger error:', err));

    return res.status(200).json({
      ok: true,
      message: `${results.length} results saved`,
      results
    });
  } catch (error: any) {
    console.error('sync-result error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}