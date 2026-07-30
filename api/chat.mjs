// Vercel Serverless Function — /api/chat
// Reads GEMINI_API_KEY from environment, proxies to Google Gemini API.
// CORS: only allows your GitHub Pages domain + localhost for development.

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

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(204).set(headers).end();
  }

  if (req.method !== "POST") {
    return res.status(405).set(headers).end(JSON.stringify({ error: "Method not allowed" }));
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).set(headers).end(JSON.stringify({ error: "GEMINI_API_KEY not set on server" }));
  }

  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).set(headers).end(JSON.stringify({ error: "message field is required" }));
    }

    const MODEL = "gemini-3.1-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

    // Build conversation contents: system instruction + history + new message
    const contents = (history || []).concat([
      { role: "user", parts: [{ text: message }] },
    ]);

    // Fetch and merge the CSV data for the system prompt
    const CSV_URL =
      "https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/export?format=csv&gid=1277715587";
    const csvRes = await fetch(CSV_URL);
    const csvText = await csvRes.text();
    const lines = csvText.trim().split("\n").slice(1);
    const services = lines
      .map((l) => {
        const c = l.split(",");
        return {
          id: c[0]?.trim(),
          category: c[1]?.trim(),
          species: c[2]?.trim(),
          price: +c[3] || 0,
          duration: +c[4] || 0,
          offer: c[8]?.trim(),
          name: c[9]?.trim(),
        };
      })
      .filter((s) => s.id);

    const serviceLines = services
      .map(
        (s) =>
          `ID:${s.id} | ${s.name} | ${s.species} | €${s.price} | ${s.duration}min | ${s.category}${s.offer ? " | OFFER: " + s.offer : ""}`
      )
      .join("\n");

    const systemInstruction = `You are the Meadow Vet Care assistant for a modern Irish veterinary clinic. Answer using ONLY the live services below — never invent prices or services.

SPECIES: dogs, cats, rabbits, small mammals, birds.
HOURS: Mon-Fri 9am-6pm, Sat 9am-1pm, closed Sundays & Irish public holidays.
EMERGENCY: 24/7 (services MVC-085 to MVC-089).
BOOKING: Most require appointment. Walk-in: microchipping, nail clipping, flea/tick/worm plans, emergencies.

LIVE SERVICES (${services.length}):
${serviceLines}

RULES: Be concise. Include price, duration. If not in data, say "I don't have that in our current list." Be friendly and professional.`;

    const body = {
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    };

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const errMsg = data.error?.message || `Gemini API returned ${geminiRes.status}`;
      return res.status(502).set(headers).end(JSON.stringify({ error: errMsg }));
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return res.status(200).set(headers).end(JSON.stringify({ reply }));
  } catch (err) {
    return res.status(500).set(headers).end(JSON.stringify({ error: err.message }));
  }
}
