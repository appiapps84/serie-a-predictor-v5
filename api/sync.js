const BBS_BASE = "https://api.bigballsdata.com";
const API_KEY = process.env.BBS_API_KEY;

const TIMEOUT = 8000;

function handler(req, res) {
  run(res);
}

async function run(res) {
  const started = Date.now();

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "BBS_API_KEY non configurata"
    });
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  try {
    const url =
      `${BBS_BASE}/v1/matches?sport=football&league=seriea`;

    console.log("BBS REQUEST:", url);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": API_KEY,
        Authorization: `Bearer ${API_KEY}`
      },
      signal: controller.signal
    });

    console.log(
      "BBS STATUS:",
      response.status,
      "TIME:",
      Date.now() - started
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: `BBS HTTP ${response.status}`,
        body: data,
        elapsedMs: Date.now() - started
      });
    }

    const matches =
      Array.isArray(data)
        ? data
        : Array.isArray(data.matches)
          ? data.matches
          : Array.isArray(data.data)
            ? data.data
            : [];

    return res.status(200).json({
      ok: true,
      source: "Big Balls Sports Data",
      matches,
      coverage: {
        matches: matches.length
      },
      elapsedMs: Date.now() - started
    });

  } catch (error) {

    console.error("BBS ERROR:", error);

    if (error.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "Big Balls Data non ha risposto entro 8 secondi",
        code: "BBS_TIMEOUT",
        elapsedMs: Date.now() - started
      });
    }

    return res.status(500).json({
      ok: false,
      error: error.message,
      elapsedMs: Date.now() - started
    });

  } finally {
    clearTimeout(timer);
  }
}

export default handler;
