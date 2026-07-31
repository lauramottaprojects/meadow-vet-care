const ALLOWED_ORIGINS = [
  "https://lauramottaprojects.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
];

const HOLIDAY_API = (year) =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/IE`;

async function loadIrishHolidays() {
  const year = new Date().getFullYear();
  const res = await fetch(HOLIDAY_API(year));
  const data = await res.json();
  return (data || [])
    .map((h) => ({ date: h.date, name: h.name || h.localName }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function holidayLines(holidays) {
  return holidays.map((h) => `- ${h.date}: ${h.name}`).join("\n");
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const setCORS = () => {
    res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  };

  try {
    setCORS();
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

    const body = req.body;
    if (!body?.message) return res.status(400).json({ error: "message field required" });

    const CSV_URL = "https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/export?format=csv&gid=1277715587";
    const [csvRes, holidays] = await Promise.all([
      fetch(CSV_URL),
      loadIrishHolidays().catch(() => []),
    ]);
    const csvText = await csvRes.text();
    const lines = csvText.trim().split("\n").slice(1);
    const services = lines.map(l => { const c = l.split(","); return { id: c[0]?.trim(), category: c[1]?.trim(), species: c[2]?.trim(), price: +c[3] || 0, duration: +c[4] || 0, appointment: c[5]?.trim() === "Yes", availability: c[6]?.trim(), slots: +c[7] || 0, offer: c[8]?.trim(), name: c[9]?.trim() }; }).filter(s => s.id);
    const serviceLines = services.map(s => `ID:${s.id} | ${s.name} | ${s.species} | €${s.price} | ${s.duration}min | ${s.category} | ${s.availability}${s.offer ? " | OFFER: " + s.offer : ""}`).join("\n");

    const systemInstruction = `You are the Meadow Vet Care assistant for a modern Irish veterinary clinic. Answer using ONLY the live services below.

SPECIES: dogs, cats, rabbits, small mammals, birds.
HOURS: Mon-Fri 9am-6pm, Sat 9am-1pm, closed Sundays & Irish public holidays.
EMERGENCY: 24/7 (MVC-085 to MVC-089).
BOOKING: Most require appointment. Walk-in: microchipping, nail clipping, flea/tick/worm plans.

IRISH PUBLIC HOLIDAYS (clinic CLOSED all day on these dates):
${holidayLines(holidays)}

LIVE SERVICES (${services.length}):
${serviceLines}

RULES: Be concise. Include price, duration. If not in data, say it's not in the current list. If asked about opening hours on a specific date, check the holiday list and the weekday before answering — the clinic is closed on Sundays and on every holiday listed above. Be friendly and professional.`;

    const contents = (body.history || []).concat([{ role: "user", parts: [{ text: body.message }] }]);
    const geminiRes = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: systemInstruction }] }, contents, generationConfig: { temperature: 0.3, maxOutputTokens: 1024 } }),
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) return res.status(502).json({ error: data.error?.message || "Gemini API error" });

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.status(200).json({ reply });
  } catch (err) {
    setCORS();
    res.status(500).json({ error: err.message || String(err) });
  }
}
