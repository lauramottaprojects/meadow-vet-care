const ALLOWED_ORIGINS = [
  "https://lauramottaprojects.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
];

const HOLIDAY_API = (year) =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/IE`;

const WEATHER_URL = (lat, lon) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,uv_index,is_day&daily=temperature_2m_max&timezone=auto&forecast_days=1`;

function weatherLabel(code) {
  if (code <= 1) return "clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code >= 45 && code <= 48) return "foggy";
  if (code >= 51 && code <= 67) return "rainy";
  if (code >= 71 && code <= 77) return "snowy";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 85 && code <= 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "unknown";
}

async function loadWeather(latitude, longitude, location) {
  const lat = latitude ?? 53.3498;
  const lon = longitude ?? -6.2603;
  const res = await fetch(WEATHER_URL(lat, lon));
  const data = await res.json();
  const c = data.current;
  return {
    time: c.time,
    temp_c: c.temperature_2m,
    feels_c: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    weather_code: c.weather_code,
    weather: weatherLabel(c.weather_code),
    wind_kmh: c.wind_speed_10m,
    uv: c.uv_index,
    is_day: c.is_day,
    high_c: data.daily?.temperature_2m_max?.[0],
    location: location || "Dublin",
  };
}

const GEOCODE_URL = (name) =>
  `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;

const geoCache = new Map();

async function geocodeIreland(name) {
  if (geoCache.has(name)) return geoCache.get(name);
  try {
    const res = await fetch(GEOCODE_URL(name));
    const data = await res.json();
    const hit = (data.results || []).find(
      (r) => r.country_code === "IE" || r.country === "Ireland"
    );
    const found = hit
      ? { name: hit.name, latitude: hit.latitude, longitude: hit.longitude }
      : null;
    geoCache.set(name, found);
    return found;
  } catch {
    geoCache.set(name, null);
    return null;
  }
}

function extractPlaceNames(text) {
  const places = [];
  const re =
    /\b(?:in|at|near|from|around|outside|for|to)\s+(?:the\s+)?([A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)*)/g;
  let m;
  while ((m = re.exec(text))) {
    places.push(m[1].replace(/^County\s+/i, ""));
  }
  return places;
}

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
    const [csvRes, holidays, weather, requestedWeather] = await Promise.all([
      fetch(CSV_URL),
      loadIrishHolidays().catch(() => []),
      loadWeather(body.latitude, body.longitude, body.location).catch(() => null),
      (async () => {
        const placeNames = extractPlaceNames(body.message || "");
        if (!placeNames.length) return null;
        const geo = await geocodeIreland(placeNames[0]);
        if (!geo) return null;
        return loadWeather(geo.latitude, geo.longitude, geo.name).catch(() => null);
      })(),
    ]);
    const csvText = await csvRes.text();
    const lines = csvText.trim().split("\n").slice(1);
    const services = lines.map(l => { const c = l.split(","); return { id: c[0]?.trim(), category: c[1]?.trim(), species: c[2]?.trim(), price: +c[3] || 0, duration: +c[4] || 0, appointment: c[5]?.trim() === "Yes", availability: c[6]?.trim(), slots: +c[7] || 0, offer: c[8]?.trim(), name: c[9]?.trim() }; }).filter(s => s.id);
    const serviceLines = services.map(s => `ID:${s.id} | ${s.name} | ${s.species} | €${s.price} | ${s.duration}min | ${s.category} | ${s.availability}${s.offer ? " | OFFER: " + s.offer : ""}`).join("\n");

    const weatherLines = [];
    if (weather) {
      weatherLines.push(`CURRENT WEATHER (${weather.location} — visitor's location, fetched ${weather.time}):
${weather.temp_c}°C air (feels ${weather.feels_c}°C) | ${weather.weather} | humidity ${weather.humidity}% | wind ${weather.wind_kmh} km/h | UV ${weather.uv} | ${weather.is_day ? "daytime" : "night"} | today's high ${weather.high_c}°C`);
    } else {
      weatherLines.push("CURRENT WEATHER: unavailable right now — say you can't check the live forecast.");
    }
    if (requestedWeather && requestedWeather.location !== weather?.location) {
      weatherLines.push(`REQUESTED LOCATION WEATHER (${requestedWeather.location}, fetched ${requestedWeather.time}):
${requestedWeather.temp_c}°C air (feels ${requestedWeather.feels_c}°C) | ${requestedWeather.weather} | humidity ${requestedWeather.humidity}% | wind ${requestedWeather.wind_kmh} km/h | UV ${requestedWeather.uv} | ${requestedWeather.is_day ? "daytime" : "night"} | today's high ${requestedWeather.high_c}°C`);
    }
    const weatherBlock = weatherLines.join("\n\n");

    const systemInstruction = `You are the Meadow Vet Care assistant for a modern Irish veterinary clinic. Answer using ONLY the live services below.

SPECIES: dogs, cats, rabbits, small mammals, birds.
HOURS: Mon-Fri 9am-6pm, Sat 9am-1pm, closed Sundays & Irish public holidays.
EMERGENCY: 24/7 (MVC-085 to MVC-089).
BOOKING: Most require appointment. Walk-in: microchipping, nail clipping, flea/tick/worm plans.

IRISH PUBLIC HOLIDAYS (clinic CLOSED all day on these dates):
${holidayLines(holidays)}

${weatherBlock}

DOG-WALK PET-SAFETY RULES:
- Air temp above 25°C: TOO HOT to walk — heatstroke and paw-burn risk. Advise staying in, or walking early morning / late evening.
- 20–25°C: warm — keep walks short and carry water.
- Below 0°C, or heavy rain, fog or wind above 40 km/h: keep walks short.
- Thunderstorm or UV above 8: keep pets inside.
- When asked things like "is it too hot to walk my dog?", answer using the CURRENT WEATHER and these rules.
- If the user asks about the weather in a specific town or city (e.g. "is it safe to walk my dog in Sligo?"), base your answer on the REQUESTED LOCATION WEATHER for that place.

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
