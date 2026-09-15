export default async function handler(req, res) {
  const API_KEY = process.env.FOOTBALL_API_KEY;
  const API_URL = 'https://v3.football.api-sports.io/fixtures?league=135&season=2026';

  if (!API_KEY) {
    return res.status(500).json({ error: 'API Key non configurata su Vercel.' });
  }

  try {
    const response = await fetch(API_URL, {
      headers: {
        'x-apisports-key': API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    const data = await response.json();

    return res.status(200).json({
      last_updated: new Date().toISOString(),
      fixtures_count: data.results,
      data: data.response
    });
  } catch (error) {
    return res.status(500).json({ error: 'Errore sync', details: error.message });
  }
}
