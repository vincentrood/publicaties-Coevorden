import fs from "fs";
import path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import OpenAI from "openai";
import { globSync } from "glob";
import pLimit from "p-limit";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

// Let op: gpt-4o-mini is de correcte naam
const MODEL_EXTRACT = "gpt-4o-mini"; 
const MODEL_SUMMARY = "gpt-4o-mini";

const MAX_CONCURRENT = 3;

/*
|--------------------------------------------------------------------------
| WOO MILESTONE DETECTION & PATTERNS
|--------------------------------------------------------------------------
*/

const WOO_PATTERNS = [
  /\bwoo[- ]?verzoek\b/i, /\bverzoek ingediend\b/i, /\baanvraag ingediend\b/i,
  /\bindienen\b/i, /\bverzoek ontvangen\b/i, /\bbesluit\b/i, /\bprimair besluit\b/i,
  /\bdefinitief besluit\b/i, /\bdeelbesluit\b/i, /\bbesloten\b/i, /\bpublicatie\b/i,
  /\bgepubliceerd\b/i, /\bopenbaar gemaakt\b/i, /\bopenbaarmaking\b/i, /\bverlengd\b/i,
  /\bverdaging\b/i, /\buitstel\b/i, /\btermijn\b/i, /\bbezwaar\b/i, /\bberoep\b/i,
  /\bvoorziening\b/i, /\bklacht\b/i, /\bjuridische procedure\b/i, /\bdocumenten verstrekt\b/i,
  /\bdocumenten openbaar\b/i, /\bstukken verstrekt\b/i, /\binformatie verstrekt\b/i,
  /\bgeweigerd\b/i, /\bafgewezen\b/i, /\bgedeeltelijk toegewezen\b/i, /\btoegewezen\b/i,
  /\bonderzoek\b/i, /\bintern onderzoek\b/i, /\bevaluatie\b/i, /\bzienswijze\b/i,
  /\breactie\b/i, /\bmededeling\b/i, /\bbrief\b/i, /\bartikel\b/i, /\bwoo\b/i, /\bwob\b/i,
  /\bafgesloten\b/i, /\barchivering\b/i, /\bdossier gesloten\b/i,
];

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}-\d{1,2}-\d{4}\b/g,
  /\b\d{1,2}\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+\d{4}\b/gi,
];

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function sha(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function hasDate(text) {
  return DATE_PATTERNS.some((regex) => regex.test(text));
}

function matchesImportantPattern(text) {
  return WOO_PATTERNS.some((regex) => regex.test(text));
}

function extractRelevantBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!matchesImportantPattern(line) && !hasDate(line)) continue;

    const start = Math.max(0, i - 3);
    const end = Math.min(lines.length, i + 4);
    const context = lines.slice(start, end).join("\n");
    const cleaned = normalizeWhitespace(context);

    if (cleaned.length < 80) continue;
    const hash = sha(cleaned);
    if (seen.has(hash)) continue;
    seen.add(hash);
    blocks.push(cleaned);
  }
  return blocks;
}

function chunkBlocks(blocks, maxChars = 12000) {
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    if ((current + block).length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += `\n\n${block}`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/*
|--------------------------------------------------------------------------
| AI EXTRACTION
|--------------------------------------------------------------------------
*/

async function analyzeChunk(chunk) {
  const response = await openai.chat.completions.create({
    model: MODEL_EXTRACT,
    temperature: 0.1,
    response_format: { type: "json_object" }, 
    messages: [
      {
        role: "system",
        content: "Je bent een data-extractor die gespecialiseerd is in Nederlandse Woo-dossiers. Antwoord ALTIJD in pure JSON."
      },
      {
        role: "user",
        content: `
Analyseer de tekst op belangrijke mijlpalen (indiening, besluit, publicatie, bezwaar, etc.).
Haal datums (YYYY-MM-DD) en een korte beschrijving op. 
Als een datum ontbreekt, sla de mijlpaal over.

OUTPUT FORMAT:
{
  "summary": "korte samenvatting van deze chunk",
  "milestones": [
    { "date": "YYYY-MM-DD", "event": "beschrijving" }
  ]
}

TEKST:
${chunk}`
      }
    ],
  });

  return JSON.parse(response.choices[0].message.content);
}

/*
|--------------------------------------------------------------------------
| FINAL SUMMARY
|--------------------------------------------------------------------------
*/

async function generateFinalSummary(partialSummaries, milestones) {
  const response = await openai.chat.completions.create({
    model: MODEL_SUMMARY,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "Vat het Woo-dossier samen in maximaal 2 zinnen. Focus op onderwerp en resultaat."
      },
      {
        role: "user",
        content: `SUMMARIES: ${partialSummaries.join("\n")}\n\nMILESTONES: ${JSON.stringify(milestones)}`
      }
    ]
  });

  return response.choices[0].message.content.trim();
}

/*
|--------------------------------------------------------------------------
| PROCESSING LOGIC
|--------------------------------------------------------------------------
*/

function dedupeMilestones(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.date || !item.event) continue;
    const key = `${item.date}-${item.event.toLowerCase().trim()}`;
    if (!map.has(key)) {
      map.set(key, { date: item.date, event: item.event.trim() });
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function processFile(file) {
  try {
    console.log(`Processing: ${file}`);
    const raw = fs.readFileSync(file, "utf8");
    const parsed = matter(raw);
    const contentHash = sha(parsed.content);

    if (parsed.data.ai_hash === contentHash) {
      console.log(`Skipped unchanged: ${file}`);
      return;
    }

    const relevantBlocks = extractRelevantBlocks(parsed.content);
    if (!relevantBlocks.length) {
      console.log(`No relevant blocks: ${file}`);
      return;
    }

    const chunks = chunkBlocks(relevantBlocks);
    const results = [];

    for (const chunk of chunks) {
      try {
        const result = await analyzeChunk(chunk);
        results.push(result);
      } catch (err) {
        console.error("Chunk analysis failed:", err);
      }
    }

    const summaries = results.map((r) => r.summary).filter(Boolean);
    const milestones = dedupeMilestones(results.flatMap((r) => r.milestones || []));
    const finalSummary = await generateFinalSummary(summaries, milestones);

    parsed.data.summary = finalSummary;
    parsed.data.milestones = milestones;
    parsed.data.ai_hash = contentHash;
    parsed.data.ai_processed_at = new Date().toISOString();

    const updated = matter.stringify(parsed.content, parsed.data);
    fs.writeFileSync(file, updated);
    console.log(`Updated: ${file}`);
  } catch (err) {
    console.error(`Failed file ${file}`, err);
  }
}

async function main() {
  const files = globSync("docs/2024/**/*.md");
  const limit = pLimit(MAX_CONCURRENT);
  await Promise.all(files.map((file) => limit(() => processFile(file))));
  console.log("Done");
}

main();
