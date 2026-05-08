import fs from "fs";
import crypto from "crypto";
import matter from "gray-matter";
import OpenAI from "openai";
import { globSync } from "glob";
import pLimit from "p-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* CONFIG */
const MODEL = "gpt-4o-mini";
const MAX_CONCURRENT = 3;

/* HELPERS */
const sha = (content) => crypto.createHash("sha256").update(content).digest("hex");

function extractRelevantBlocks(markdown) {
  // Filtert op trefwoorden en datums, negeert standaard juridische bijlagen
  const ignorePatterns = /bezwaar en beroep|wettelijk kader|artikel 5\./i;
  const importantPatterns = /woo|besluit|verzoek|publicatie|termijn|afgehandeld/i;
  const datePattern = /\d{1,2}[-/\s](jan|feb|maa|apr|mei|jun|jul|aug|sep|okt|nov|dec|[0-9]{1,2})[-/\s]\d{4}/i;

  return markdown.split("\n")
    .filter(line => !ignorePatterns.test(line))
    .filter(line => importantPatterns.test(line) || datePattern.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 40);
}

/* AI LOGIC */
async function analyzeContent(textBlocks) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0, // Lager is betrouwbaarder voor data extractie
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Je bent een data-extractor voor Nederlandse Woo-dossiers. 
        Extraheer mijlpalen. Gebruik voor datums STRIKT het ISO-formaat: YYYY-MM-DD.
        Negeer instructieteksten en historische data van voor 2020.`
      },
      {
        role: "user",
        content: `Geef een JSON met "summary" (max 2 zinnen) en "milestones" [{date, event}]. 
        Tekst: ${textBlocks.join("\n")}`
      }
    ],
  });
  return JSON.parse(response.choices[0].message.content);
}

/* PROCESSING */
function cleanMilestones(milestones) {
  const seen = new Set();
  return milestones
    .filter(m => /^\d{4}-\d{2}-\d{2}$/.test(m.date) && m.event)
    .filter(m => parseInt(m.date.substring(0, 4)) >= 2020)
    .filter(m => {
      const id = `${m.date}-${m.event.toLowerCase()}`;
      return seen.has(id) ? false : seen.add(id);
    })
    .sort((a, b) => a.date.localeCompare(b.date)); // ISO datums sorteren perfect als string
}

async function processFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const { data, content } = matter(raw);
    const contentHash = sha(content);

    if (data.ai_hash === contentHash) return;

    const blocks = extractRelevantBlocks(content);
    if (blocks.length === 0) return;

    // We pakken de belangrijkste blokken (beperkt ivm context window)
    const result = await analyzeContent(blocks.slice(0, 50)); 
    
    data.summary = result.summary;
    data.milestones = cleanMilestones(result.milestones);
    data.ai_hash = contentHash;
    data.ai_processed_at = new Date().toISOString();

    fs.writeFileSync(file, matter.stringify(content, data));
    console.log(`✅ Updated: ${file}`);
  } catch (err) {
    console.error(`❌ Failed: ${file}`, err.message);
  }
}

async function main() {
  const files = globSync("docs/2024/**/*.md");
  const limit = pLimit(MAX_CONCURRENT);
  await Promise.all(files.map(f => limit(() => processFile(f))));
  console.log("Gereed.");
}

main();
