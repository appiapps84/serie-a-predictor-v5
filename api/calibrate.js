import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { data: predictions } = await supabase
      .from('predictions')
      .select('*')
      .order('predicted_at', { ascending: false });

    if (!predictions || predictions.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No predictions yet',
        stats: null
      });
    }

    const { data: results } = await supabase
      .from('results')
      .select('*');

    const matched = predictions
      .map(p => ({
        ...p,
        result: results?.find(r => r.match_id === p.match_id)
      }))
      .filter(p => p.result !== undefined);

    if (matched.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No matched predictions',
        stats: null
      });
    }

    const correct = matched.filter(
      p => p.prediction_1x2 === p.result.result_1x2
    ).length;
    const globalAccuracy = correct / matched.length;

    const recent10 = matched.slice(0, 10);
    const recent10Correct = recent10.filter(
      p => p.prediction_1x2 === p.result.result_1x2
    ).length;
    const recentAccuracy = recent10.length > 0 ? recent10Correct / recent10.length : globalAccuracy;

    const shrinkageWeight = 0.3;
    const shrunkenAccuracy =
      globalAccuracy * (1 - shrinkageWeight) +
      recentAccuracy * shrinkageWeight;

    const mae =
      matched.reduce((sum, p) => {
        const predGols = (p.xg_home || 0) + (p.xg_away || 0);
        const actualGols = p.result.goals_home + p.result.goals_away;
        return sum + Math.abs(predGols - actualGols);
      }, 0) / matched.length;

    return res.status(200).json({
      ok: true,
      stats: {
        globalAccuracy: (globalAccuracy * 100).toFixed(2) + '%',
        recentAccuracy: (recentAccuracy * 100).toFixed(2) + '%',
        shrunkenAccuracy: (shrunkenAccuracy * 100).toFixed(2) + '%',
        mae: mae.toFixed(2),
        totalMatched: matched.length
      }
    });
  } catch (error) {
    console.error('calibrate error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
