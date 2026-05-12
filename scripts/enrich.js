import fs from "fs";
import matter from "gray-matter";
import OpenAI from "openai";
import { globSync } from "glob";
import pLimit from "p-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* CONFIG */
const MODEL = "gpt-4o-mini";
const MAX_CONCURRENT = 1;
const MAX_TOKENS_PER_REQUEST = 6000; // Veiligheidsmarge voor milestones
const MAX_SUMMARY_TOKENS = 30000;    // Harde bovengrens voor de samenvatting

/* ------------------ UTIL ------------------ */

const estimateTokens = (text) => Math.ceil(text.length / 4);

function normalizeDate(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------ RETRY WRAPPER ------------------ */

async function withRetry(fn, retries = 5) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRateLimit = err?.status === 429 || err?.message?.includes("Rate limit");
      const isContext = err?.status === 400 || err?.message?.includes("maximum context length");

      if (isRateLimit) {
        console.warn(`⏳ Rate limit geraakt. Wachten... (${i + 1}/${retries})`);
        await sleep(2000 * Math.pow(2, i));
        continue;
      }
      
      if (isContext) {
        console.warn("⚠️ Context te groot, blok overgeslagen.");
        return null; 
      }
      throw err;
    }
  }
  throw lastErr;
}

/* ------------------ CHUNKING & FILTERING ------------------ */

function extractRelevantBlocks(text) {
  const ignore = /bezwaar en beroep|wettelijk kader|artikel 5\./i;
  const important = /woo|besluit|verzoek|publicatie|termijn|afgehandeld|vastgesteld|toegekend|verlengd/i;
  const date = /\d{1,2}[-/\s](jan|feb|maa|apr|mei|jun|jul|aug|sep|okt|nov|dec|[0-9]{1,2})[-/\s]\d{4}/i;

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

function buildSafeChunks(blocks) {
  const chunks = [];
  let current = [];
  let tokens = 0;

  for (const block of blocks) {
    const t = estimateTokens(block);

    // FIX: Als 1 blok extreem groot is (bijv. geen alinea-scheidingen in de PDF)
    // Knippen we het hier geforceerd in kleinere stukken om crashes te voorkomen.
    if (t > MAX_TOKENS_PER_REQUEST) {
      let remainingText = block;
      while (remainingText.length > 0) {
        const sliceSize = MAX_TOKENS_PER_REQUEST * 4; // Max karakters per veilige chunk
        const piece = remainingText.substring(0, sliceSize);
        chunks.push([piece]);
        remainingText = remainingText.substring(sliceSize);
      }
      continue;
    }

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
  const paragraphs = text.split(/\n\s*\n/);
  let summaryText = paragraphs
    .map((p) => {
      let score = 0;
      const lower = p.toLowerCase();
      if (/besluit|beslissing|toegekend|afgewezen|verlengd|gegrond|ongegrond/.test(lower)) score += 5;
      if (/aanvraag|verzoek|reactie|zienswijze|document|onderzoek|rapport/.test(lower)) score += 3;
      if (/college|burgemeester|gemeente|bestuurlijk|afdeling/.test(lower)) score += 2;
      if (p.length > 200) score += 1;
      return { text: p.trim(), score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((p) => p.text)
    .join("\n\n");

  if (estimateTokens(summaryText) > MAX_SUMMARY_TOKENS) {
    summaryText = summaryText.substring(0, MAX_SUMMARY_TOKENS * 4);
  }
  return summaryText;
}

/* ------------------ AI ------------------ */

async function analyzeContent(textBlocks) {
  if (!textBlocks || textBlocks.length === 0) return null;
  
  return withRetry(async () => {
    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Je bent een expert in Nederlandse Woo-dossiers. Taak: Extraheer een chronologische tijdlijn en samenvatting. Gebruik ISO datums (YYYY-MM-DD). Negeer vóór 2020.",
        },
        {
          role: "user",
          content: `Geef STRICT JSON:\n{\n  "summary": "max 2 zinnen",\n  "milestones": [{ "date": "YYYY-MM-DD", "event": "kort" }]\n}\n\nTEKST:\n${Array.isArray(textBlocks) ? textBlocks.join("\n\n") : textBlocks}`,
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

    if ((data.summary && data.summary.trim().length > 0) || (Array.isArray(data.milestones) && data.milestones.length > 0)) {
      return; // Skip al verwerkte bestanden
    }

    const blocks = extractRelevantBlocks(content);
    if (blocks.length === 0) return;

    // --- SUMMARY ---
    const summaryInput = extractSummaryBlocksSmart(content);
    const summaryResult = await analyzeContent(summaryInput);
    const summary = summaryResult?.summary || "";

    // --- MILESTONES ---
    const chunks = buildSafeChunks(blocks);
    let allMilestones = [];
    const MAX_CHUNKS_PER_FILE = 3;

    for (const chunk of chunks.slice(0, MAX_CHUNKS_PER_FILE)) {
      await sleep(1500); // Iets langere pauze om de Rate Limit (TPM) te sparen
      const result = await analyzeContent(chunk);
      if (result?.milestones?.length) {
        allMilestones.push(...result.milestones);
      }
    }

    const cleaned = cleanMilestones(allMilestones);

    data.summary = summary;
    data.milestones = cleaned;
    data.ai_processed_at = new Date().toISOString();
    delete data.ai_hash;

    fs.writeFileSync(file, matter.stringify(content, data));
    console.log(`✅ Updated: ${file}`);
    
  } catch (err) {
    console.error(`❌ Failed: ${file} | Reden: ${err.message}`);
  }
}

/* ------------------ MAIN ------------------ */

async function main() {
  const files = globSync("docs/2024/**/*.md");
  const limit = pLimit(MAX_CONCURRENT);

  await Promise.all(files.map((f) => limit(() => processFile(f))));
  console.log("Gereed.");
}

main();
