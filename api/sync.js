export default async function handler(request) {
  return new Response(
    JSON.stringify({
      ok: true,
      message: "SYNC FUNCTION FUNZIONA",
      time: new Date().toISOString()
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
