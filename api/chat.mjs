const ALLOWED_ORIGINS = [
  "https://lauramottaprojects.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

function errorRes(res, headers, status, msg) {
  return res.status(status).set(headers).end(JSON.stringify({ error: msg }));
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return res.status(204).set(headers).end();
  if (req.method !== "POST") return errorRes(res, headers, 405, "Method not allowed");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return errorRes(res, headers, 500, "GEMINI_API_KEY not set");

  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim())
      return errorRes(res, headers, 400, "message field is required");

    const MODEL = "gemini-3.1-flash-lite";

    // Load CSV
    const CSV_URL = "https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/export?format=csv&gid=1277715587";
    const csvRes = await fetch(CSV_URL);
    const csvText = await csvRes.text();
    const lines = csvText.trim().split("\n").slice(1);
    const services = lines.map(l => { const c = l.split(","); return { id: c[0]?.trim(), category: c[1]?.trim(), species: c[2]?.trim(), price: +c[3] || 0, duration: +c[4] || 0, offer: c[8]?.trim(), name: c[9]?.trim() }; }).filter(s => s.id);

    const serviceLines = services.map(s => `ID:${s.id} | ${s.name} | ${s.species} | €${s.price} | ${s.duration}min | ${s.category}${s.offer ? " | OFFER: " + s.offer : ""}`).join("\n");

    const systemInstruction = `You are the Meadow Vet Care assistant. Answer using ONLY the live services below.

HOURS: Mon-Fri 9am-6pm, Sat 9am-1pm, closed Sundays & Irish public holidays.
EMERGENCY: 24/7 (MVC-085 to MVC-089).

LIVE SERVICES (${services.length}):
${serviceLines}

RULES: Be concise. Include price, duration. If not in data, say "I don't have that in our current list."`;

    const contents = (history || []).concat([{ role: "user", parts: [{ text: message }] }]);

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: systemInstruction }] }, contents, generationConfig: { temperature: 0.3, maxOutputTokens: 1024 } }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) return errorRes(res, headers, 502, data.error?.message || `Gemini API ${geminiRes.status}`);

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return res.status(200).set(headers).end(JSON.stringify({ reply }));
  } catch (err) {
    return errorRes(res, headers, 500, err.message || String(err));
  }
}
