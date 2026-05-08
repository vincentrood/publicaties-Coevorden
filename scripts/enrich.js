import fs from "fs";
import crypto from "crypto";
import matter from "gray-matter";
import OpenAI from "openai";
import { globSync } from "glob";
import pLimit from "p-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* CONFIG */
const MODEL = "gpt-4o-mini";
const MAX_CONCURRENT = 1;
// We verlagen dit naar 15.000 om ruim onder de limieten te blijven en kosten te sparen
const MAX_TOKENS_PER_REQUEST = 15000; 

/* ------------------ UTIL ------------------ */

const sha = (content) =>
  crypto.createHash("sha256").update(content).digest("hex");

// Iets conservatievere schatting (3 karakters per token voor NL tekst)
const estimateTokens = (text) => Math.ceil(text.length / 3);

function normalizeDate(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------ RETRY WRAPPER ------------------ */

async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRateLimit = err?.status === 429 || err?.message?.includes("Rate limit");
      if (isRateLimit) {
        const wait = 5000 * Math.pow(2, i);
        console.log(`⚠️ Rate limit. Wachten voor ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/* ------------------ CHUNKING & CLEANING ------------------ */

function getSafeParagraphs(text) {
  // Splits op dubbele enters, maar filter ook extreem lange lappen tekst zonder witregel
  return text.split(/\n\s*\n/).flatMap(p => {
    if (p.length > 10000) {
        // Forceer split bij reusachtige blokken om 400 errors te voorkomen
        return p.match(/.{1,10000}/g) || [p];
    }
    return p;
  });
}

function extractRelevantBlocks(text) {
  const ignore = /bezwaar en beroep|wettelijk kader|artikel 5\./i;
  const important = /woo|besluit|verzoek|publicatie|termijn|afgehandeld|vastgesteld|toegekend|verlengd/i;
  const date = /\d{1,2}[-/\s](jan|feb|maa|apr|mei|jun|jul|aug|sep|okt|nov|dec|[0-9]{1,2})[-/\s]\d{4}/i;

  const paragraphs = getSafeParagraphs(text);

  const scored = paragraphs
    .map((p) => {
      let score = 0;
      if (ignore.test(p)) score -= 5;
      if (important.test(p)) score += 3;
      if (date.test(p)) score += 5;
      if (p.length > 80) score += 1;
      return { text: p.trim(), score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((p) => p.text);
}

function buildSafeChunks(blocks) {
  const chunks = [];
  let current = [];
  let tokens = 0;

  for (const block of blocks) {
    const t = estimateTokens(block);
    if (tokens + t > MAX_TOKENS_PER_REQUEST) {
      if (current.length) chunks.push(current);
      current = [block];
      tokens = t;
    } else {
      current.push(block);
      tokens += t;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function extractSummaryBlocksSmart(text) {
  const paragraphs = getSafeParagraphs(text);
  
  const scored = paragraphs
    .map((p) => {
      let score = 0;
      const lower = p.toLowerCase();
      if (/besluit|beslissing|toegekend|afgewezen|verlengd/.test(lower)) score += 5;
      if (/aanvraag|verzoek|zienswijze/.test(lower)) score += 3;
      if (p.length > 200) score += 1;
      return { text: p.trim(), score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15); // Pak de top 15 meest relevante paragrafen

  return scored.map(p => p.text).join("\n\n");
}

/* ------------------ AI ------------------ */

async function analyzeContent(textBlocks, isSummaryTask = false) {
  const combinedText = Array.isArray(textBlocks) ? textBlocks.join("\n\n") : textBlocks;
  
  // Failsafe: als de tekst nog steeds te groot is, hard inkorten
  const safeText = combinedText.slice(0, MAX_TOKENS_PER_REQUEST * 3);

  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Je bent een expert in Nederlandse Woo-dossiers. Extraheer informatie in STRICT JSON formaat."
        },
        {
          role: "user",
          content: `
Taak: ${isSummaryTask ? "Schrijf een samenvatting van max 2 zinnen." : "Extraheer een chronologische tijdlijn (YYYY-MM-DD) van processtappen vanaf 2020."}

JSON Structuur:
{
  "summary": "string",
  "milestones": [ { "date": "YYYY-MM-DD", "event": "string" } ]
}

TEKST:
${safeText}`
        }
      ],
    });

    return JSON.parse(response.choices[0].message.content);
  });
}

/* ------------------ FILE PROCESSING ------------------ */

async function processFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);

    const hash = sha(content);
    if (data.ai_hash === hash) return;

    // 1. Samenvatting genereren op basis van slimme selectie
    const summaryInput = extractSummaryBlocksSmart(content);
    const summaryResult = await analyzeContent(summaryInput, true);
    
    // 2. Milestones genereren via chunking
    const blocks = extractRelevantBlocks(content);
    const chunks = buildSafeChunks(blocks);
    let allMilestones = [];

    // Verwerk max 3 chunks om kosten en context te bewaken
    for (const chunk of chunks.slice(0, 3)) {
      const result = await analyzeContent(chunk, false);
      if (result.milestones) allMilestones.push(...result.milestones);
    }

    // Schoonmaken
    const seen = new Set();
    const cleanedMilestones = allMilestones
      .map(m => ({ date: normalizeDate(m.date), event: m.event?.trim() }))
      .filter(m => m.date && m.event && parseInt(m.date.slice(0, 4)) >= 2020)
      .filter(m => {
        const id = `${m.date}-${m.event.toLowerCase()}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    // Update data
    data.summary = summaryResult.summary || "";
    data.milestones = cleanedMilestones;
    data.ai_hash = hash;
    data.ai_processed_at = new Date().toISOString();

    fs.writeFileSync(file, matter.stringify(content, data));
    console.log(`✅ Verwerkt: ${file}`);

  } catch (err) {
    console.error(`❌ Fout bij ${file}:`, err.message);
  }
}

async function main() {
  const files = globSync("docs/2025/**/*.md");
  console.log(`Start met verwerken van ${files.length} bestanden...`);
  
  const limit = pLimit(MAX_CONCURRENT);
  await Promise.all(files.map((f) => limit(() => processFile(f))));

  console.log("Gereed.");
}

main();
