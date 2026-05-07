import fs from "fs";
import matter from "gray-matter";
import OpenAI from "openai";
import path from "path";
import { globSync } from "glob";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 1. pak alle markdown files
const files = globSync("docs/2024/*.md");

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = matter(raw);

  // 2. skip als al verrijkt (optioneel)
  if (parsed.data.summary && parsed.data.milestones) continue;

  // 3. AI prompt
  const prompt = `
Je krijgt markdown content.

Maak:
1. summary (1 zin, NL)
2. milestones als JSON array met date + event

Output STRICT JSON:

{
  "summary": "...",
  "milestones": [
    { "date": "YYYY-MM-DD", "event": "..." }
  ]
}

CONTENT:
${parsed.content}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  let ai;
  try {
    ai = JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error("AI gaf geen valide JSON voor:", file);
    continue;
  }

  // 4. voeg toe aan front matter (onderaan metadata blok)
  parsed.data.summary = ai.summary;
  parsed.data.milestones = ai.milestones;

  // 5. schrijf terug
  const updated = matter.stringify(parsed.content, parsed.data);
  fs.writeFileSync(file, updated);

  console.log("Updated:", file);
}
