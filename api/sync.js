export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    test: "SYNC-12345",
    time: new Date().toISOString()
  });
}
