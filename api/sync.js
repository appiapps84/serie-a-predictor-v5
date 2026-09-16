const BBS_BASE =
  "https://api.bigballsdata.com";

const LEAGUE =
  "serie-a";

const SPORT =
  "football";

const TIMEOUT =
  10000;

function send(res, status, body) {
  res.status(status);
  res.setHeader(
    "Content-Type",
    "application/json"
  );
  return res.json(body);
}

function first(...values) {
  return values.find(
    v =>
      v !== undefined &&
      v !== null &&
      v !== ""
  );
}

function number(value) {

  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function teamName(team) {

  if (!team) return null;

  if (typeof team === "string") {
    return team;
  }

  return first(
    team.name,
    team.display_name,
    team.short_name,
    team.common_name
  );
}

function teamId(team) {

  if (!team || typeof team !== "object") {
    return null;
  }

  return first(
    team.id,
    team.team_id
  );
}

function normalizeName(name) {

  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

}

async function bbsFetch(path, key) {

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      TIMEOUT
    );

  try {

    const response =
      await fetch(
        `${BBS_BASE}${path}`,
        {
          headers: {
            Authorization:
              `Bearer ${key}`,

            "X-API-Key":
              key,

            Accept:
              "application/json"
          },

          signal:
            controller.signal
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        text
          ? JSON.parse(text)
          : null;
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {

      const error =
        new Error(
          `BBD HTTP ${response.status}`
        );

      error.status =
        response.status;

      error.body =
        data;

      throw error;
    }

    return data;

  } finally {

    clearTimeout(timer);

  }

}

function arrayFrom(data) {

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.matches)) {
    return data.matches;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  return [];

}

function normalizeMatch(match) {

  const home =
    match.home ||
    match.home_team ||
    match.homeTeam ||
    match.teams?.home;

  const away =
    match.away ||
    match.away_team ||
    match.awayTeam ||
    match.teams?.away;

  return {

    id:
      first(
        match.id,
        match.match_id
      ),

    homeTeam:
      teamName(home),

    awayTeam:
      teamName(away),

    homeTeamId:
      teamId(home),

    awayTeamId:
      teamId(away),

    homeTeamKey:
      normalizeName(
        teamName(home)
      ),

    awayTeamKey:
      normalizeName(
        teamName(away)
      ),

    kickoff:
      first(
        match.kickoff,
        match.start_time,
        match.startTime,
        match.date,
        match.utc_date
      ),

    status:
      first(
        match.status,
        match.match_status,
        match.state
      ),

    matchday:
      first(
        match.matchday,
        match.round,
        match.week
      ),

    homeScore:
      number(
        first(
          match.home_score,
          match.homeScore,
          match.scores?.home,
          match.score?.home
        )
      ),

    awayScore:
      number(
        first(
          match.away_score,
          match.awayScore,
          match.scores?.away,
          match.score?.away
        )
      )

  };

}

function extractXG(data) {

  const root =
    data?.data ||
    data?.stats ||
    data;

  if (!root) {

    return {
      homeXG: null,
      awayXG: null
    };

  }

  const home =
    root.home ||
    root.home_team ||
    root.homeTeam ||
    root.teams?.home ||
    {};

  const away =
    root.away ||
    root.away_team ||
    root.awayTeam ||
    root.teams?.away ||
    {};

  return {

    homeXG:
      number(
        first(
          home.xg,
          home.XG,
          home.expected_goals,
          root.home_xg,
          root.homeXG,
          root.xg_home
        )
      ),

    awayXG:
      number(
        first(
          away.xg,
          away.XG,
          away.expected_goals,
          root.away_xg,
          root.awayXG,
          root.xg_away
        )
      )

  };

}

function normalizeLineups(data) {

  const root =
    data?.data ||
    data;

  if (!root) {

    return {
      home: [],
      away: [],
      available: false
    };

  }

  const home =
    root.home ||
    root.home_team ||
    root.homeTeam ||
    root.lineups?.home ||
    [];

  const away =
    root.away ||
    root.away_team ||
    root.awayTeam ||
    root.lineups?.away ||
    [];

  return {

    home:
      Array.isArray(home)
        ? home
        : [],

    away:
      Array.isArray(away)
        ? away
        : [],

    available:
      Array.isArray(home) &&
      Array.isArray(away)

  };

}

async function getDetails(matches, key) {

  /*
    Limitiamo le richieste dettagliate alle partite
    recenti/prossime. Questo protegge il free tier BBD.
  */

  const now =
    Date.now();

  const candidates =
    matches.filter(match => {

      if (!match.kickoff) {
        return false;
      }

      const time =
        new Date(
          match.kickoff
        ).getTime();

      if (!Number.isFinite(time)) {
        return false;
      }

      const hours =
        (
          now - time
        ) / 3600000;

      return (
        hours >= -48 &&
        hours <= 72
      );

    });

  const limited =
    candidates.slice(0, 50);

  const results = [];

  for (
    const match of limited
  ) {

    let xG = {
      homeXG: null,
      awayXG: null
    };

    let lineups = {
      home: [],
      away: [],
      available: false
    };

    try {

      const stats =
        await bbsFetch(
          `/v1/stored/matches/${encodeURIComponent(match.id)}/stats`,
          key
        );

      xG =
        extractXG(stats);

    } catch (error) {

      console.warn(
        "Stats:",
        match.id,
        error.message
      );

    }

    try {

      const lineup =
        await bbsFetch(
          `/v1/stored/matches/${encodeURIComponent(match.id)}/lineups`,
          key
        );

      lineups =
        normalizeLineups(
          lineup
        );

    } catch (error) {

      console.warn(
        "Lineup:",
        match.id,
        error.message
      );

    }

    results.push({

      id:
        String(match.id),

      xG,

      lineups

    });

  }

  return results;

}

export default async function handler(
  req,
  res
) {

  if (req.method !== "GET") {

    return send(
      res,
      405,
      {
        ok: false,
        error:
          "METHOD_NOT_ALLOWED"
      }
    );

  }

  const key =
    process.env.BBS_API_KEY;

  if (!key) {

    return send(
      res,
      500,
      {
        ok: false,

        error:
          "BBS_API_KEY_MISSING",

        message:
          "Aggiungi BBS_API_KEY nelle Environment Variables di Vercel."
      }
    );

  }

  try {

    const matchesResponse =
      await bbsFetch(
        `/v1/matches?sport=${SPORT}&league=${LEAGUE}`,
        key
      );

    const rawMatches =
      arrayFrom(
        matchesResponse
      );

    const matches =
      rawMatches
        .map(normalizeMatch)
        .filter(
          m =>
            m.id &&
            m.homeTeam &&
            m.awayTeam
        );

    let standings = [];

    try {

      const standingsResponse =
        await bbsFetch(
          `/v1/standings?sport=${SPORT}&league=${LEAGUE}`,
          key
        );

      standings =
        arrayFrom(
          standingsResponse
        );

    } catch (error) {

      console.warn(
        "Standings non disponibili:",
        error.message
      );

    }

    const details =
      await getDetails(
        matches,
        key
      );

    const detailMap =
      new Map();

    details.forEach(detail => {

      detailMap.set(
        String(detail.id),
        detail
      );

    });

    const enriched =
      matches.map(match => {

        const detail =
          detailMap.get(
            String(match.id)
          );

        return {

          ...match,

          xG:
            detail?.xG || {
              homeXG: null,
              awayXG: null
            },

          lineups:
            detail?.lineups || {
              home: [],
              away: [],
              available: false
            }

        };

      });

    const xgCount =
      enriched.filter(
        match =>
          match.xG.homeXG !== null &&
          match.xG.awayXG !== null
      ).length;

    const lineupCount =
      enriched.filter(
        match =>
          match.lineups.available
      ).length;

    return send(
      res,
      200,
      {

        ok: true,

        source:
          "Big Balls Sports Data",

        league:
          "serie-a",

        generatedAt:
          new Date().toISOString(),

        coverage: {

          matches:
            enriched.length,

          xG:
            xgCount,

          lineups:
            lineupCount

        },

        matches:
          enriched,

        standings

      }
    );

  } catch (error) {

    console.error(
      "BBD SYNC ERROR",
      error
    );

    return send(
      res,
      error.status || 500,
      {

        ok: false,

        error:
          "SYNC_FAILED",

        message:
          error.message ||
          "Errore BBD."

      }
    );

  }

}
