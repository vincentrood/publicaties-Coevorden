import fs from "fs";
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

const MODEL_EXTRACT = "gpt-4o-mini"; 
const MODEL_SUMMARY = "gpt-4o-mini";
const MAX_CONCURRENT = 3;

/*
|--------------------------------------------------------------------------
| PATTERNS
|--------------------------------------------------------------------------
*/

const WOO_PATTERNS = [
  /\bwoo[- ]?verzoek\b/i, /\bindiening\b/i, /\bontvangstbevestiging\b/i,
  /\bbesluit\b/i, /\bdeelbesluit\b/i, /\bprimair besluit\b/i, /\bbeslissing\b/i,
  /\bopenbaarmaking\b/i, /\bpublicatie\b/i, 
  /\bverdaagd\b/i, /\bverlenging\b/i, /\buitstel\b/i,
  /\bbezwaarschrift\b/i, /\bbezwaar\b/i, /\bberoep\b/i, /\bhoger beroep\b/i,
  /\buitspraak\b/i, /\bvoorlopige voorziening\b/i,
  /\bdossier gesloten\b/i, /\bafgehandeld\b/i
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

  // Secties die we volledig negeren om ruis (zoals handleidingen) te voorkomen
  const ignoreSections = [
    /bezwaar en beroep/i, 
    /wettelijk kader/i, 
    /relevante artikelen/i, 
    /artikel 5\./i,
    /over de gemeente coevorden/i
  ];

  let skipSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detecteer of we in een algemene informatie-sectie zitten
    if (ignoreSections.some(regex => regex.test(line))) {
      skipSection = true;
      continue;
    }
    
    // Bij een nieuwe Markdown header stoppen we het skippen
    if (line.startsWith('##')) skipSection = false;

    if (skipSection) continue;
    if (!matchesImportantPattern(line) && !hasDate(line)) continue;

    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 3);
    const context = lines.slice(start, end).join("\n");
    const cleaned = normalizeWhitespace(context);

    if (cleaned.length < 60) continue;
    const hash = sha(cleaned);
    if (seen.has(hash)) continue;
    seen.add(hash);
    blocks.push(cleaned);
  }
  return blocks;
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
        content: "Je bent een data-extractor gespecialiseerd in Nederlandse Woo-dossiers. Antwoord uitsluitend in JSON."
      },
      {
        role: "user",
        content: `
Analyseer de tekst op de belangrijkste juridische mijlpalen van het HUIDIGE Woo-traject.

FOCUS OP:
1. De datum van het eigenlijke verzoek (vaak eind 2023 of 2024).
2. Besluiten, termijnverlengingen en feitelijke openbaarmakingen.

NEGEER STRIKT:
- Historische datums (jaren '80, '90, vroege 2000) over oude bestemmingsplannen.
- Instructie-teksten over hoe je bezwaar MOET maken (geen "DD-MM-YYYY" of "zes weken" regels).
- Algemene informatie over de Wet open overheid zelf.

OUTPUT FORMAT:
{
  "summary": "korte samenvatting van deze chunk",
  "milestones": [
    { "date": "DD-MM-YYYY", "event": "bondige beschrijving" }
  ]
}

TEKST:
${chunk}`
      }
    ],
  });

  return JSON.parse(response.choices[0].message.content);
}

async function generateFinalSummary(partialSummaries, milestones) {
  const response = await openai.chat.completions.create({
    model: MODEL_SUMMARY,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "Vat het Woo-dossier samen in maximaal 2 zinnen. Focus op onderwerp en eindresultaat."
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
  
  const validItems = items.filter(item => {
    if (!item.date || !item.event) return false;
    
    // Verwijder AI placeholders en "Onbekend"
    const d = item.date.toUpperCase();
    if (d.includes('DD') || d.includes('MM') || d.includes('YYYY') || d.includes('ONBEKEND')) return false;

    // Jaar-filter: negeer alles van voor 2020 (historische ruis)
    const parts = item.date.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[2]);
      if (year < 2020) return false;
    }

    return true;
  });

  for (const item of validItems) {
    const key = `${item.date}-${item.event.toLowerCase().trim()}`;
    if (!map.has(key)) {
      map.set(key, { date: item.date, event: item.event.trim() });
    }
  }

  return [...map.values()].sort((a, b) => {
    const [dayA, monthA, yearA] = a.date.split('-').map(Number);
    const [dayB, monthB, yearB] = b.date.split('-').map(Number);
    return new Date(yearA, monthA - 1, dayA) - new Date(yearB, monthB - 1, dayB);
  });
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
    if (!relevantBlocks.length) return;

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

function chunkBlocks(blocks, maxChars = 10000) {
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

async function main() {
  const files = globSync("docs/2024/**/*.md");
  const limit = pLimit(MAX_CONCURRENT);
  await Promise.all(files.map((file) => limit(() => processFile(file))));
  console.log("Done");
}

main();
