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

const MODEL_EXTRACT = "gpt-4.1-mini";
const MODEL_SUMMARY = "gpt-4.1-mini";

const MAX_CONCURRENT = 3;

/*
|--------------------------------------------------------------------------
| WOO MILESTONE DETECTION
|--------------------------------------------------------------------------
|
| Deze patronen bepalen WELKE stukken tekst belangrijk zijn.
| We sturen NIET het hele document naar AI.
|
| We verzamelen:
| - milestone regels
| - omliggende context
| - headings
| - datums
|
*/

const WOO_PATTERNS = [
  // verzoeken
  /\bwoo[- ]?verzoek\b/i,
  /\bverzoek ingediend\b/i,
  /\baanvraag ingediend\b/i,
  /\bindienen\b/i,
  /\bverzoek ontvangen\b/i,

  // besluiten
  /\bbesluit\b/i,
  /\bprimair besluit\b/i,
  /\bdefinitief besluit\b/i,
  /\bdeelbesluit\b/i,
  /\bbesloten\b/i,

  // publicatie
  /\bpublicatie\b/i,
  /\bgepubliceerd\b/i,
  /\bopenbaar gemaakt\b/i,
  /\bopenbaarmaking\b/i,

  // termijnen
  /\bverlengd\b/i,
  /\bverdaging\b/i,
  /\buitstel\b/i,
  /\btermijn\b/i,

  // bezwaar / beroep
  /\bbezwaar\b/i,
  /\bberoep\b/i,
  /\bvoorziening\b/i,
  /\bklacht\b/i,
  /\bjuridische procedure\b/i,

  // documenten
  /\bdocumenten verstrekt\b/i,
  /\bdocumenten openbaar\b/i,
  /\bstukken verstrekt\b/i,
  /\binformatie verstrekt\b/i,

  // weigeringen
  /\bgeweigerd\b/i,
  /\bafgewezen\b/i,
  /\bgedeeltelijk toegewezen\b/i,
  /\btoegewezen\b/i,

  // onderzoek
  /\bonderzoek\b/i,
  /\bintern onderzoek\b/i,
  /\bevaluatie\b/i,

  // communicatie
  /\bzienswijze\b/i,
  /\breactie\b/i,
  /\bmededeling\b/i,
  /\bbrief\b/i,

  // juridische verwijzingen
  /\bartikel\b/i,
  /\bwoo\b/i,
  /\bwob\b/i,

  // archief / afsluiting
  /\bafgesloten\b/i,
  /\barchivering\b/i,
  /\bdossier gesloten\b/i,
];

/*
|--------------------------------------------------------------------------
| DATE PATTERNS
|--------------------------------------------------------------------------
*/

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g, // 2024-05-01
  /\b\d{1,2}-\d{1,2}-\d{4}\b/g, // 01-05-2024
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

/*
|--------------------------------------------------------------------------
| EXTRACT RELEVANT BLOCKS
|--------------------------------------------------------------------------
|
| Belangrijk:
| - neem context mee
| - neem headings mee
| - vermijd duplicate boilerplate
| - focus op milestone signalen
|
*/

function extractRelevantBlocks(markdown) {
  const lines = markdown.split("\n");

  const blocks = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const important =
      matchesImportantPattern(line) || hasDate(line);

    if (!important) continue;

    // pak context rondom event
    const start = Math.max(0, i - 3);
    const end = Math.min(lines.length, i + 4);

    const context = lines
      .slice(start, end)
      .join("\n");

    const cleaned = normalizeWhitespace(context);

    // skip korte ruis
    if (cleaned.length < 80) continue;

    // dedupe
    const hash = sha(cleaned);

    if (seen.has(hash)) continue;

    seen.add(hash);

    blocks.push(cleaned);
  }

  return blocks;
}

/*
|--------------------------------------------------------------------------
| CHUNKING
|--------------------------------------------------------------------------
*/

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

  if (current.trim()) {
    chunks.push(current);
  }

  return chunks;
}

/*
|--------------------------------------------------------------------------
| AI EXTRACTION
|--------------------------------------------------------------------------
|
| AI krijgt ALLEEN:
| - milestone verdachte context
| - omliggende tekst
|
| Hierdoor:
| - extreem lage kosten
| - hoge relevantie
|
*/

async function analyzeChunk(chunk) {
  const response = await openai.responses.create({
    model: MODEL_EXTRACT,
    temperature: 0.1,

    input: `
Je analyseert een Nederlands Woo/Wob dossier.

Herken ALLEEN belangrijke gebeurtenissen.

VOORBEELDEN VAN BELANGRIJKE MILESTONES:
- indiening Woo-verzoek
- ontvangstbevestiging
- besluit genomen
- publicatie documenten
- documenten openbaar gemaakt
- afwijzing
- gedeeltelijke toewijzing
- bezwaar
- beroep
- verlenging termijn
- verdaging
- zienswijze
- juridische procedure
- intern onderzoek gestart
- dossier gesloten

NEGEER:
- standaard juridische boilerplate
- irrelevante verwijzingen
- lange wetsartikelen
- herhalingen

BELANGRIJK:
- gebruik alleen gebeurtenissen die echt betekenisvol zijn
- combineer dubbele gebeurtenissen
- maak event beschrijving kort maar informatief
- haal datum uit context
- als geen duidelijke datum aanwezig is: sla event over

OUTPUT STRICT JSON:

{
  "summary": "korte samenvatting",
  "milestones": [
    {
      "date": "YYYY-MM-DD",
      "event": "..."
    }
  ]
}

TEKST:
${chunk}
`,
  });

  return JSON.parse(response.output_text);
}

/*
|--------------------------------------------------------------------------
| DEDUPE MILESTONES
|--------------------------------------------------------------------------
*/

function dedupeMilestones(items) {
  const map = new Map();

  for (const item of items) {
    if (!item.date || !item.event) continue;

    const normalizedEvent = item.event
      .toLowerCase()
      .trim();

    const key = `${item.date}-${normalizedEvent}`;

    if (!map.has(key)) {
      map.set(key, {
        date: item.date,
        event: item.event.trim(),
      });
    }
  }

  return [...map.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
}

/*
|--------------------------------------------------------------------------
| FINAL SUMMARY
|--------------------------------------------------------------------------
*/

async function generateFinalSummary(
  partialSummaries,
  milestones
) {
  const response = await openai.responses.create({
    model: MODEL_SUMMARY,
    temperature: 0.2,

    input: `
Vat dit Woo-dossier samen in maximaal 2 zinnen.

Focus op:
- onderwerp
- uitkomst
- belangrijkste processtappen

PARTIAL SUMMARIES:
${partialSummaries.join("\n")}

MILESTONES:
${JSON.stringify(milestones, null, 2)}
`,
  });

  return response.output_text.trim();
}

/*
|--------------------------------------------------------------------------
| PROCESS FILE
|--------------------------------------------------------------------------
*/

async function processFile(file) {
  try {
    console.log(`Processing: ${file}`);

    const raw = fs.readFileSync(file, "utf8");

    const parsed = matter(raw);

    /*
    |--------------------------------------------------------------------------
    | HASH CHECK
    |--------------------------------------------------------------------------
    */

    const contentHash = sha(parsed.content);

    if (parsed.data.ai_hash === contentHash) {
      console.log(`Skipped unchanged: ${file}`);
      return;
    }

    /*
    |--------------------------------------------------------------------------
    | EXTRACT RELEVANT CONTENT
    |--------------------------------------------------------------------------
    */

    const relevantBlocks =
      extractRelevantBlocks(parsed.content);

    if (!relevantBlocks.length) {
      console.log(`No relevant blocks: ${file}`);
      return;
    }

    /*
    |--------------------------------------------------------------------------
    | CHUNK
    |--------------------------------------------------------------------------
    */

    const chunks = chunkBlocks(relevantBlocks);

    /*
    |--------------------------------------------------------------------------
    | ANALYZE
    |--------------------------------------------------------------------------
    */

    const results = [];

    for (const chunk of chunks) {
      try {
        const result = await analyzeChunk(chunk);
        results.push(result);
      } catch (err) {
        console.error("Chunk analysis failed:", err);
      }
    }

    /*
    |--------------------------------------------------------------------------
    | MERGE RESULTS
    |--------------------------------------------------------------------------
    */

    const summaries = results
      .map((r) => r.summary)
      .filter(Boolean);

    const milestones = dedupeMilestones(
      results.flatMap((r) => r.milestones || [])
    );

    /*
    |--------------------------------------------------------------------------
    | FINAL SUMMARY
    |--------------------------------------------------------------------------
    */

    const finalSummary =
      await generateFinalSummary(
        summaries,
        milestones
      );

    /*
    |--------------------------------------------------------------------------
    | WRITE FRONTMATTER
    |--------------------------------------------------------------------------
    */

    parsed.data.summary = finalSummary;
    parsed.data.milestones = milestones;
    parsed.data.ai_hash = contentHash;
    parsed.data.ai_processed_at =
      new Date().toISOString();

    const updated = matter.stringify(
      parsed.content,
      parsed.data
    );

    fs.writeFileSync(file, updated);

    console.log(`Updated: ${file}`);
  } catch (err) {
    console.error(`Failed file ${file}`, err);
  }
}

/*
|--------------------------------------------------------------------------
| RUN
|--------------------------------------------------------------------------
*/

async function main() {
  const files = globSync("docs/**/*.md");

  const limit = pLimit(MAX_CONCURRENT);

  await Promise.all(
    files.map((file) =>
      limit(() => processFile(file))
    )
  );

  console.log("Done");
}

main();
