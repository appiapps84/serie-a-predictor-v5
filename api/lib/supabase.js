// Client Supabase "lazy": se le env var mancano NON fa crashare la funzione.
// Prima (V5) createClient() era a livello di modulo: qualunque richiesta,
// anche un semplice GET, faceva 500. Ora il fallimento e' silenzioso e gestito.

import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabase() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  try {
    client = createClient(url, key);
    return client;
  } catch {
    return null;
  }
}
