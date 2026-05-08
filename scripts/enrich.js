import fs from "fs";
import crypto from "crypto";
import matter from "gray-matter";
import OpenAI from "openai";
import { globSync } from "glob";
import pLimit from "p-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* CONFIG (functioneel onveranderd) */
const MODEL = "gpt-4o-mini";
const MAX_CONCURRENT = 1; // FIX: voorkomt TPM spikes (was 3)
const MAX_TOKENS_PER_REQUEST = 6000;
const TARGET_BLOCKS = 25;

/* ------------------ UTIL ------------------ */

const sha = (content) =>
  crypto.createHash("sha256").update(content).digest("hex");

const estimateTokens = (text) => Math.ceil(text.length / 4);

function normalizeDate(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

/* ------------------ RETRY WRAPPER (NEW) ------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, retries = 4) {
  let lastErr;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const isRateLimit =
        err?.status === 429 || err?.message?.includes("Rate limit");

      const isContext =
        err?.message?.includes("maximum context length") ||
        err?.status === 400;

      if (isRateLimit || isContext) {
        const backoff = 2000 * Math.pow(2, i);
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}

/* ------------------ CHUNKING ------------------ */

function extractRelevantBlocks(text) {
  const ignore = /bezwaar en beroep|wettelijk kader|artikel 5\./i;
  const important =
    /woo|besluit|verzoek|publicatie|termijn|afgehandeld|vastgesteld|toegekend|verlengd/i;
  const date =
    /\d{1,2}[-/\s](jan|feb|maa|apr|mei|jun|jul|aug|sep|okt|nov|dec|[0-9]{1,2})[-/\s]\d{4}/i;

  const paragraphs = text.split(/\n\s*\n/);

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

/* ------------------ SAFE CHUNKING (UNCHANGED LOGIC) ------------------ */

function buildSafeChunks(blocks) {
  const chunks = [];
  let current = [];
  let tokens = 0;

  for (const block of blocks) {
    const t = estimateTokens(block);

    if (tokens + t > MAX_TOKENS_PER_REQUEST) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }

    current.push(block);
    tokens += t;
  }

  if (current.length) chunks.push(current);

  return chunks;
}

/* ------------------ AI ------------------ */

async function analyzeContent(textBlocks) {
  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Je bent een expert in Nederlandse Woo-dossiers.

Taak:
- Extraheer een chronologische tijdlijn van gebeurtenissen.
- Alleen echte processtappen (geen herhaling of juridische boilerplate).
- Gebruik altijd ISO datums (YYYY-MM-DD).
- Negeer alles vóór 2020.
- Als datum onzeker is: negeer het event.
          `.trim(),
        },
        {
          role: "user",
          content: `
Geef STRICT JSON:
{
  "summary": "max 2 zinnen",
  "milestones": [
    { "date": "YYYY-MM-DD", "event": "kort en concreet" }
  ]
}

TEKST:
${textBlocks.join("\n\n")}
          `.trim(),
        },
      ],
    });

    return JSON.parse(response.choices[0].message.content);
  });
}

/* ------------------ CLEANING ------------------ */

function cleanMilestones(milestones) {
  const seen = new Set();

  return milestones
    .map((m) => ({
      date: normalizeDate(m.date),
      event: m.event?.trim(),
    }))
    .filter((m) => m.date && m.event)
    .filter((m) => parseInt(m.date.slice(0, 4)) >= 2020)
    .filter((m) => {
      const id = `${m.date}-${m.event.toLowerCase()}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------ FILE PROCESSING ------------------ */

async function processFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);

    const hash = sha(content);
    if (data.ai_hash === hash) return;

    const blocks = extractRelevantBlocks(content);
    if (blocks.length === 0) return;

    const chunks = buildSafeChunks(blocks);

    let allMilestones = [];
    let summary = "";

    const MAX_CHUNKS_PER_FILE = 2; // FIX: voorkomt context + TPM spikes

    for (const chunk of chunks.slice(0, MAX_CHUNKS_PER_FILE)) {
      await sleep(1200); // FIX: stabiliseert TPM usage

      const result = await analyzeContent(chunk);

      if (!summary && result.summary) {
        summary = result.summary;
      }

      if (result.milestones?.length) {
        allMilestones.push(...result.milestones);
      }
    }

    const cleaned = cleanMilestones(allMilestones);

    data.summary = summary;
    data.milestones = cleaned;
    data.ai_hash = hash;
    data.ai_processed_at = new Date().toISOString();

    fs.writeFileSync(file, matter.stringify(content, data));

    console.log(`✅ Updated: ${file}`);
  } catch (err) {
    console.error(`❌ Failed: ${file}`, err.message);
  }
}

/* ------------------ MAIN ------------------ */

async function main() {
  const files = globSync("docs/2025/**/*.md");
  const limit = pLimit(MAX_CONCURRENT);

  await Promise.all(files.map((f) => limit(() => processFile(f))));

  console.log("Gereed.");
}

main();
