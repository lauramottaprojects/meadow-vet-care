import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/* ─── config ─── */
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("  ❌ Set GEMINI_API_KEY environment variable, e.g.:");
  console.error('     $env:GEMINI_API_KEY="your-key"  (PowerShell)');
  console.error('     export GEMINI_API_KEY="your-key" (bash)');
  process.exit(1);
}
const MODEL = "gemini-3.1-flash-lite";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const RATE_LIMIT_RPM = 15;
const MIN_INTERVAL_MS = Math.ceil(60000 / RATE_LIMIT_RPM); // 4000ms

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/export?format=csv&gid=1277715587";

const HOLIDAY_API = (year) =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/IE`;

const WEATHER_LOCATION = process.env.WEATHER_LOCATION || "Dublin";
const WEATHER_LAT = process.env.WEATHER_LAT ? +process.env.WEATHER_LAT : 53.3498;
const WEATHER_LON = process.env.WEATHER_LON ? +process.env.WEATHER_LON : -6.2603;

const HISTORY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "chat_history.json"
);

/* ─── rate limiter ─── */
let lastCallTime = 0;

function waitForRateLimit() {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_INTERVAL_MS) {
    const wait = MIN_INTERVAL_MS - elapsed;
    console.log(`  ⏳ rate limit: waiting ${(wait / 1000).toFixed(1)}s...`);
    return new Promise((r) => setTimeout(r, wait));
  }
  return Promise.resolve();
}

/* ─── load CSV data ─── */
async function loadServices() {
  const res = await fetch(CSV_URL);
  const text = await res.text();
  const lines = text.trim().split("\n").slice(1);
  return lines.map((l) => {
    const c = l.split(",");
    return {
      id: c[0]?.trim(),
      category: c[1]?.trim(),
      species: c[2]?.trim(),
      price_eur: +c[3] || 0,
      duration_min: +c[4] || 0,
      requires_appointment: c[5]?.trim() === "Yes",
      availability: c[6]?.trim(),
      slots_this_week: +c[7] || 0,
      special_offer: c[8]?.trim(),
      service_name: c[9]?.trim(),
    };
  }).filter((s) => s.id);
}

/* ─── load Irish public holidays ─── */
async function loadIrishHolidays() {
  const year = new Date().getFullYear();
  const res = await fetch(HOLIDAY_API(year));
  const data = await res.json();
  return (data || [])
    .map((h) => ({ date: h.date, name: h.name || h.localName }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ─── load live weather (Dublin) ─── */
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

async function loadWeatherAt(latitude, longitude, location) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,uv_index,is_day&daily=temperature_2m_max&timezone=auto&forecast_days=1`;
  const res = await fetch(url);
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
    location,
  };
}

async function loadWeather() {
  return loadWeatherAt(WEATHER_LAT, WEATHER_LON, WEATHER_LOCATION);
}

/* ─── geocode an Irish place name mentioned in a message ─── */
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

/* ─── build system prompt ─── */
function buildSystemPrompt(services, holidays, weather, requestedWeather) {
  const lines = services.map(s => `- ID:${s.id} | ${s.service_name} | ${s.species} | €${s.price_eur} | ${s.duration_min}min | ${s.category} | ${s.availability} | ${s.requires_appointment ? "appointment" : "walk-in"} | slots:${s.slots_this_week}${s.special_offer ? " | OFFER: " + s.special_offer : ""}`).join("\n");
  const holidayLines = holidays.map(h => `- ${h.date}: ${h.name}`).join("\n");
  const baseBlock = weather
    ? `CURRENT WEATHER (${weather.location} — visitor's location, fetched ${weather.time}):
${weather.temp_c}°C air (feels ${weather.feels_c}°C) | ${weather.weather} | humidity ${weather.humidity}% | wind ${weather.wind_kmh} km/h | UV ${weather.uv} | ${weather.is_day ? "daytime" : "night"} | today's high ${weather.high_c}°C`
    : "CURRENT WEATHER: unavailable right now — say you can't check the live forecast.";
  const requestedBlock = requestedWeather
    ? `REQUESTED LOCATION WEATHER (${requestedWeather.location}, fetched ${requestedWeather.time}):
${requestedWeather.temp_c}°C air (feels ${requestedWeather.feels_c}°C) | ${requestedWeather.weather} | humidity ${requestedWeather.humidity}% | wind ${requestedWeather.wind_kmh} km/h | UV ${requestedWeather.uv} | ${requestedWeather.is_day ? "daytime" : "night"} | today's high ${requestedWeather.high_c}°C`
    : "";
  const weatherBlock = [baseBlock, requestedBlock].filter(Boolean).join("\n\n");

  return `You are the Meadow Vet Care assistant, working for a modern Irish veterinary clinic in Ireland. Answer customer questions using ONLY the live services data below.

TREATS: dogs, cats, rabbits, small mammals, birds.
LOCATION: Ireland.
HOURS: Mon-Fri 9am-6pm, Sat 9am-1pm, closed Sundays and Irish public holidays.
EMERGENCY: 24/7 (services MVC-085 to MVC-089).
BOOKING: Most require appointment. Walk-in: microchipping, nail clipping, flea/tick/worm plans, emergencies.

IRISH PUBLIC HOLIDAYS (clinic CLOSED all day on these dates):
${holidayLines}

${weatherBlock}

DOG-WALK PET-SAFETY RULES:
- Air temp above 25°C: TOO HOT to walk — heatstroke and paw-burn risk. Advise staying in, or walking early morning / late evening.
- 20–25°C: warm — keep walks short and carry water.
- Below 0°C, or heavy rain, fog or wind above 40 km/h: keep walks short.
- Thunderstorm or UV above 8: keep pets inside.
- When asked things like "is it too hot to walk my dog?", answer using the CURRENT WEATHER and these rules.
- If the user asks about the weather in a specific town or city (e.g. "is it safe to walk my dog in Sligo?"), base your answer on the REQUESTED LOCATION WEATHER for that place.

LIVE SERVICES (94 total):
${lines}

RULES:
1. Answer ONLY from the data above. Never invent prices or services.
2. Include price in euros, duration, and availability.
3. When listing multiple services, format as a clear list.
4. If not in data, say "I don't have that in our current services list."
5. If asked about opening hours on a specific date, check the holiday list and the weekday before answering — the clinic is closed on Sundays and on every holiday listed above.
6. Be friendly and professional.`;
}

/* ─── Gemini API call ─── */
async function askGemini(systemPrompt, history, userMessage) {
  await waitForRateLimit();
  lastCallTime = Date.now();

  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = data.error?.message || JSON.stringify(data);
    if (res.status === 429) {
      console.log("  ⚠️  429 rate limited — waiting 10s...");
      await new Promise((r) => setTimeout(r, 10000));
      return askGemini(systemPrompt, history, userMessage); // retry
    }
    throw new Error(`API error ${res.status}: ${err}`);
  }

  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text ||
    "(empty response)";
  return text;
}

/* ─── history management ─── */
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
}

function clearHistory() {
  if (existsSync(HISTORY_FILE)) {
    writeFileSync(HISTORY_FILE, "[]", "utf-8");
  }
}

/* ─── terminal chat loop ─── */
function askQuestion(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function main() {
  console.log("\n  🌿 Meadow Vet Care — Terminal Chat");
  console.log(`  🤖 Model: ${MODEL}`);
  console.log(`  ⚡ Rate limit: ${RATE_LIMIT_RPM} req/min\n`);

  // Load data
  console.log("  📡 Loading services, holidays & weather...");
  let services, holidays, weather;
  try {
    [services, holidays, weather] = await Promise.all([
      loadServices(),
      loadIrishHolidays().catch(() => []),
      loadWeather().catch(() => null),
    ]);
    console.log(`  ✅ ${services.length} services loaded`);
    console.log(`  🌿 ${holidays.length} Irish public holidays loaded`);
    console.log(weather
      ? `  🌤 ${weather.location}: ${weather.temp_c}°C, ${weather.weather}, wind ${weather.wind_kmh} km/h, UV ${weather.uv}\n`
      : "  ⚠️  Weather unavailable\n");
  } catch (e) {
    console.error("  ❌ Failed to load data:", e.message);
    process.exit(1);
  }

  const baseSystemPrompt = buildSystemPrompt(services, holidays, weather);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  // Handle interrupt gracefully
  rl.on("SIGINT", () => {
    console.log("\n\n  👋 Goodbye!");
    saveHistory(history);
    rl.close();
    process.exit(0);
  });

  let history = loadHistory();
  console.log(
    `  📋 Loaded ${history.length} previous message(s) from history\n`
  );

  console.log("  Commands:");
  console.log("    /new    — start a new conversation");
  console.log("    /save   — save history to disk");
  console.log("    /clear  — clear saved history");
  console.log("    /stats  — show session stats");
  console.log("    /quit   — exit\n");

  let turnCount = 0;
  const startTime = Date.now();

  while (true) {
    const input = await askQuestion(rl, "  You > ");

    const cmd = input.trim().toLowerCase();

    if (cmd === "/quit") {
      console.log("\n  👋 Goodbye!");
      saveHistory(history);
      break;
    }

    if (cmd === "/new") {
      history = [];
      turnCount = 0;
      console.log("  🆕 Conversation history cleared.\n");
      continue;
    }

    if (cmd === "/save") {
      saveHistory(history);
      console.log(`  💾 Saved ${history.length} messages.\n`);
      continue;
    }

    if (cmd === "/clear") {
      clearHistory();
      console.log("  🗑️  Saved history file cleared.\n");
      continue;
    }

    if (cmd === "/stats") {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(
        `  📊 Turn: ${turnCount} | History: ${history.length} msgs | Session: ${elapsed} min\n`
      );
      continue;
    }

    if (!input.trim()) continue;

    turnCount++;
    try {
      let systemPrompt = baseSystemPrompt;
      const placeNames = extractPlaceNames(input);
      if (placeNames.length) {
        const geo = await geocodeIreland(placeNames[0]);
        if (geo) {
          const reqW = await loadWeatherAt(geo.latitude, geo.longitude, geo.name).catch(() => null);
          if (reqW && reqW.location !== weather?.location) {
            systemPrompt = buildSystemPrompt(services, holidays, weather, reqW);
          }
        }
      }
      const reply = await askGemini(systemPrompt, history, input);

      console.log(`  🤖 Meadow assistant > ${reply}\n`);

      history.push({ role: "user", content: input });
      history.push({ role: "assistant", content: reply });

      // Keep history manageable (last 20 turns)
      if (history.length > 40) {
        history = history.slice(history.length - 40);
      }

      // Auto-save every 5 turns
      if (turnCount % 5 === 0) {
        saveHistory(history);
        console.log(`  💾 Auto-saved (${turnCount} turns)\n`);
      }
    } catch (e) {
      console.error(`  ❌ Error: ${e.message}\n`);
    }
  }

  saveHistory(history);
  rl.close();
}

main().catch(console.error);
