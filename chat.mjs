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

/* ─── build system prompt ─── */
function buildSystemPrompt(services) {
  const lines = services.map(s => `- ID:${s.id} | ${s.service_name} | ${s.species} | €${s.price_eur} | ${s.duration_min}min | ${s.category} | ${s.availability} | ${s.requires_appointment ? "appointment" : "walk-in"} | slots:${s.slots_this_week}${s.special_offer ? " | OFFER: " + s.special_offer : ""}`).join("\n");

  return `You are the Meadow Vet Care assistant, working for a modern Irish veterinary clinic in Ireland. Answer customer questions using ONLY the live services data below.

TREATS: dogs, cats, rabbits, small mammals, birds.
LOCATION: Ireland.
HOURS: Mon-Fri 9am-6pm, Sat 9am-1pm, closed Sundays and Irish public holidays.
EMERGENCY: 24/7 (services MVC-085 to MVC-089).
BOOKING: Most require appointment. Walk-in: microchipping, nail clipping, flea/tick/worm plans, emergencies.

LIVE SERVICES (94 total):
${lines}

RULES:
1. Answer ONLY from the data above. Never invent prices or services.
2. Include price in euros, duration, and availability.
3. When listing multiple services, format as a clear list.
4. If not in data, say "I don't have that in our current services list."
5. Be friendly and professional.`;
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
  console.log("  📡 Loading services from Google Sheets...");
  let services;
  try {
    services = await loadServices();
    console.log(`  ✅ ${services.length} services loaded\n`);
  } catch (e) {
    console.error("  ❌ Failed to load services:", e.message);
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt(services);
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
