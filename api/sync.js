export default async function handler(req, res) {
  const API_KEY = process.env.FOOTBALL_API_KEY;

  if (!API_KEY) {
    return res.status(401).json({ 
      error: 'API_KEY_MISSING',
      message: 'La variabile FOOTBALL_API_KEY non è configurata su Vercel.' 
    });
  }

  const endpoints = [
    'https://api.bigballsdata.com/v1/fixtures?league=serie-a',
    'https://api.bigballsdata.com/v1/serie-a/fixtures',
    'https://api.bigballsdata.com/v1/matches?competition=serie_a'
  ];

  let responseData = null;
  let lastStatus = 404;

  for (const url of endpoints) {
    try {
      const resApi = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'X-API-Key': API_KEY,
          'Accept': 'application/json'
        }
      });

      if (resApi.ok) {
        responseData = await resApi.json();
        break;
      } else {
        lastStatus = resApi.status;
      }
    } catch (e) {
      // Prova il successivo se fallisce la connessione
    }
  }

  if (!responseData) {
    return res.status(lastStatus).json({ 
      error: 'BBD_ENDPOINT_NOT_FOUND',
      status: lastStatus,
      message: 'Impossibile trovare l\'endpoint corretto su Big Balls Data.'
    });
  }

  const rawData = Array.isArray(responseData) ? responseData : (responseData.data || []);

  // MAPPING DELLE PARTITE CON FORMAZIONI ED ASSENTI
  const processedFixtures = rawData.map(fixture => {
    const homeAbsCount = fixture.home_absentees_count || (fixture.home_absentees ? fixture.home_absentees.length : 0);
    const awayAbsCount = fixture.away_absentees_count || (fixture.away_absentees ? fixture.away_absentees.length : 0);

    return {
      id: fixture.id || fixture.match_id,
      homeTeam: fixture.home_team || fixture.homeTeam,
      awayTeam: fixture.away_team || fixture.awayTeam,
      matchday: fixture.matchday || fixture.round || 8,
      homeStartersPct: Math.max(50, 100 - (homeAbsCount * 7)),
      awayStartersPct: Math.max(50, 100 - (awayAbsCount * 7)),
      homeRestDays: fixture.home_rest_days || 7,
      awayRestDays: fixture.away_rest_days || 7,

      // NUOVI CAMPI FORMAZIONI ED ASSENTI
      homeLineup: fixture.home_lineup || fixture.home_probable_lineup || [],
      awayLineup: fixture.away_lineup || fixture.away_probable_lineup || [],
      homeAbsentees: fixture.home_absentees || fixture.home_absentees_list || [],
      awayAbsentees: fixture.away_absentees || fixture.away_absentees_list || []
    };
  });

  return res.status(200).json({
    last_updated: new Date().toISOString(),
    source: 'Big Balls Data',
    fixtures_count: processedFixtures.length,
    fixtures: processedFixtures
  });
}
