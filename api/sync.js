export default async function handler(req, res) {
  // Legge la chiave dalle impostazioni di Vercel
  const API_KEY = process.env.FOOTBALL_API_KEY;

  if (!API_KEY) {
    return res.status(401).json({ error: 'API Key non trovata su Vercel.' });
  }

  // Endpoint BBD per la Serie A
  const API_URL = 'https://api.bigballsdata.com/v1/serie-a/fixtures?season=2026';

  try {
    const response = await fetch(API_URL, {
      headers: {
        'X-API-Key': API_KEY, // Prova sia X-API-Key che Bearer token
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Errore BBD (${response.status}): ${response.statusText}` 
      });
    }

    const rawData = await response.json();

    const processedFixtures = (rawData || []).map(fixture => ({
      id: fixture.id,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      matchday: fixture.matchday,
      homeStartersPct: Math.max(50, 100 - ((fixture.home_absentees_count || 0) * 7)),
      awayStartersPct: Math.max(50, 100 - ((fixture.away_absentees_count || 0) * 7)),
      homeRestDays: fixture.home_rest_days || 7,
      awayRestDays: fixture.away_rest_days || 7
    }));

    return res.status(200).json({
      last_updated: new Date().toISOString(),
      source: 'Big Balls Data',
      fixtures_count: processedFixtures.length,
      fixtures: processedFixtures
    });
  } catch (error) {
    return res.status(500).json({ 
      error: 'Errore di connessione a BBD', 
      details: error.message 
    });
  }
}
