// Normalizzazione nomi squadre condivisa da TUTTO il backend.
// Una sola fonte di verita': sync e predict producono/consumano le stesse chiavi.

const EXTRA_WORDS = /\b(fc|ac|as|ss|ssc|usc|udinese|calcio|1899|1907|1909|1913|1920|1926|1928|1929)\b/g;

export function normalizeTeamName(value) {
  let s = String(value || "").toLowerCase().trim();

  // toglie accenti (Napoli resta napoli,毋 problemi con ch/è etc.)
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // solo lettere/numeri/spazi
  s = s.replace(/[^a-z0-9\s]/g, " ");

  // toglie suffissi/prefissi tipici (fc, ac, as, anno di fondazione...)
  s = s.replace(EXTRA_WORDS, " ");

  // collassa spazi multipli
  s = s.replace(/\s+/g, " ").trim();

  // alias finali
  const aliases = {
    "inter milan": "inter",
    "internazionale": "inter",
    "como 1907": "como",
    "as roma": "roma",
    "ac milan": "milan",
    "venezia fc": "venezia"
  };

  return aliases[s] || s;
}

// Chiave H2H stabile indipendente dall'ordine casa/trasferta
export function h2hKey(teamA, teamB) {
  const a = normalizeTeamName(teamA);
  const b = normalizeTeamName(teamB);
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}
