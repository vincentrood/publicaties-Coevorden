# Documentatie: Publicaties Coevorden
**Doorzoekbaar publicatieplatform voor gemeentelijke PDF-documenten**

---

## Inhoudsopgave

1. [Functionele omschrijving](#functionele-omschrijving)
2. [Technische omschrijving](#technische-omschrijving)
3. [Architectuuroverzicht](#architectuuroverzicht)
4. [Datapijplijn: stap voor stap](#datapijplijn)
5. [Componentenbeschrijving](#componenten)
6. [Configuratie en omgevingsvariabelen](#configuratie)
7. [Bekende beperkingen en aandachtspunten](#beperkingen)

---

## 1. Functionele omschrijving <a name="functionele-omschrijving"></a>

### Doel

Het platform maakt officiële PDF-publicaties van de gemeente Coevorden — zoals Woo-besluiten, vergunningen en correspondentie — **doorzoekbaar en toegankelijk voor inwoners**. Documenten die normaal gesproken onvindbaar op een S3-bucket staan, worden via een geautomatiseerd proces omgezet naar doorzoekbare webpagina's.

### Gebruikersinterface

De gebruiker opent de website via een webbrowser en ziet een eenvoudige zoekinterface met drie keuzemogelijkheden:

- **Jaarselectie (2024 / 2025 / 2026):** Activeert Pagefind-zoekfunctionaliteit voor het geselecteerde jaar. Resultaten tonen documenttitels, tekstfragmenten met gemarkeerde zoektermen, en filteropties op categorie of zaak.
- **Zoeken met AI:** Schakelt over naar een ingebedde CustomGPT-assistent die in natuurlijke taal vragen over de documenten kan beantwoorden.
- **Samenvatting en tijdlijn per document:** Elk Woo-dossier bevat een door AI gegenereerde samenvatting en een chronologische tijdlijn van mijlpalen, zichtbaar in de zoekresultaten.

### Doelgroep

- Inwoners van Coevorden die informatie zoeken over gemeentelijke besluiten
- Journalisten en onderzoekers die Woo-verzoeken volgen
- Gemeenteambtenaren die interne transparantie willen verbeteren

---

## 2. Technische omschrijving <a name="technische-omschrijving"></a>

### Technologiestack

| Laag | Technologie | Rol |
|------|------------|-----|
| Bronopslag | Amazon S3 (`publicaties-coevorden`) | Opslag van originele PDF-bestanden |
| Tekstextractie | `pdftotext` (Poppler) | Converteert PDF naar platte tekst |
| Contentbeheer | Hugo (statische sitegenerator) | Bouwt HTML-pagina's van Markdown-bestanden |
| Zoekindex | Pagefind | Bouwt en serveert een clientside zoekindex |
| AI-verrijking | OpenAI GPT-4o-mini via Node.js | Genereert samenvattingen en tijdlijnen per document |
| Hosting | Amazon S3 (`publicaties-coevorden-site`) + Cloudflare | Serveert de statische website; CDN, HTTPS en caching |
| Automatisering | GitHub Actions | Orkestreert de volledige pipeline |
| AI-chatinterface | CustomGPT (embedded) | Biedt natuurlijke-taalzoekopdrachten over de documenten |

### Opslagstructuur

```
S3: publicaties-coevorden/          ← Bronbucket (PDF's)
    └── 2024/
        ├── categorie/
        │   └── document.pdf

GitHub repository/
    ├── docs/
    │   └── 2024/
    │       └── categorie/
    │           └── document.md     ← Markdown met PDF-tekst + frontmatter
    ├── content/
    │   └── docs/                   ← Gekopieerd voor Hugo-build
    └── public/                     ← Hugo-uitvoer (tijdelijk)

S3: publicaties-coevorden-site/     ← Hostingbucket (website)
    └── 2024/
        ├── index.html
        └── _pagefind/              ← Zoekindex
```

### Automatiseringsworkflows

Het systeem bevat twee GitHub Actions-workflows:

**`deploy.yml` — Dagelijkse synchronisatie en sitebouw**
- Trigger: elke dag om middernacht, bij push naar `main`, of handmatig
- Haalt nieuwe PDF's op uit S3, converteert ze naar Markdown
- Verwijdert Markdown-bestanden waarvan de bron-PDF niet meer bestaat
- Bouwt de Hugo-site, genereert de Pagefind-index, en deployt naar S3

**`generate-graph.yml` — AI-verrijking van documenten**
- Trigger: handmatig (`workflow_dispatch`)
- Verwerkt Markdown-bestanden die nog geen samenvatting of tijdlijn hebben
- Roept de OpenAI API aan met gefilterde en gechunkte tekstblokken
- Schrijft `summary`, `milestones` en `ai_processed_at` terug naar de frontmatter

### Gegevensverwerking per document

Een PDF doorloopt de volgende transformatiestappen:

```
PDF (S3)
  → pdftotext (ruwe tekst)
  → Markdown met frontmatter (title, source, maps, date)
  → [optioneel] OpenAI GPT-4o-mini (summary, milestones)
  → Hugo (HTML-pagina)
  → Pagefind (zoekindex)
  → S3-hostingbucket (gepubliceerd)
```

### Frontmatter-structuur per document

```yaml
---
title: "Naam van het document"
maps: ["2024", "categorie"]
source: "2024/categorie/document.pdf"
date: 2024-03-15
summary: "Korte samenvatting gegenereerd door AI."
milestones:
  - date: "2024-01-10"
    event: "Woo-verzoek ingediend"
  - date: "2024-03-15"
    event: "Besluit vastgesteld"
ai_processed_at: "2024-04-01T08:23:11.000Z"
---
[ruwe PDF-tekst]
```

### Beveiliging en toegangsbeheer

- AWS-credentials worden opgeslagen als GitHub Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- De sitebucket gebruikt aparte credentials (`AWS_ACCESS_KEY_ID_SITE`) met minimale rechten
- Cloudflare biedt DDoS-bescherming, HTTPS-terminatie en edge-caching
- De CustomGPT API-sleutel staat momenteel hardcoded in `index.html` — dit verdient aandacht (zie §7)

### Cloudflare-integratie

Cloudflare staat tussen de browser en de S3-hostingbucket als CDN en beveiligingslaag:

- **HTTPS:** TLS-terminatie bij de edge, S3 hoeft geen certificaat te beheren
- **Caching:** Statische assets (JS, CSS, Pagefind-index) worden gecached op edge-nodes
- **DDoS-bescherming:** Automatische bescherming tegen volumetrische aanvallen
- **Custom domein:** Cloudflare koppelt een leesbaar domein aan de S3-bucket-URL

---

## 3. Architectuuroverzicht <a name="architectuuroverzicht"></a>

*Zie bijgevoegd diagram: `diagram-architectuur.svg`*

Het systeem bestaat uit drie logische lagen:

1. **Databron:** Amazon S3 met originele PDF-bestanden, beheerd buiten het platform
2. **Verwerkingspijplijn:** GitHub Actions orkestreert extractie, AI-verrijking en sitebouw
3. **Leveringslaag:** Cloudflare + S3 levert de statische site aan eindgebruikers

---

## 4. Datapijplijn: stap voor stap <a name="datapijplijn"></a>

*Zie bijgevoegd diagram: `diagram-pipeline.svg`*

### Stap 1 — S3-synchronisatie
De workflow haalt een lijst op van alle PDF-bestanden in de geconfigureerde map (`SYNC_FOLDER`). Voor elke PDF die nog geen overeenkomend Markdown-bestand heeft, wordt de PDF gedownload en via `pdftotext` omgezet naar platte tekst. De tekst wordt opgeslagen als Markdown met basisfrontmatter.

### Stap 2 — Opruimen van verwijderde bestanden
PDF's die niet meer in S3 bestaan maar wel een Markdown-bestand hebben, worden verwijderd. Dit houdt de repository en de website synchroon met de bronbucket.

### Stap 3 — AI-verrijking (handmatig)
De afzonderlijke `enrich`-workflow verwerkt bestanden zonder samenvatting. De tekst wordt gefilterd op relevantie (datums, besluitterminologie), opgedeeld in chunks, en aangeboden aan GPT-4o-mini. De resultaten worden teruggeschreven naar de frontmatter.

### Stap 4 — Hugo-build
Hugo converteert alle Markdown-bestanden naar HTML-pagina's, met de taxonomie uit de `maps`-frontmatter-sleutel als navigatiestructuur.

### Stap 5 — Pagefind-index
Pagefind crawlt de Hugo-uitvoer en bouwt een clientside zoekindex. De index wordt als statische bestanden naast de HTML opgeslagen.

### Stap 6 — Deploy naar S3
De volledige `public/`-map wordt gesynchroniseerd naar de hostingbucket. Met `--delete` worden verouderde bestanden verwijderd. Cloudflare serveert vervolgens de bijgewerkte site aan eindgebruikers.

---

## 5. Componentenbeschrijving <a name="componenten"></a>

### `deploy.yml`
GitHub Actions-workflow voor dagelijkse synchronisatie. Beheert de volledige pipeline van S3-ophalen tot deploy. Configureert met de omgevingsvariabele `SYNC_FOLDER` welk jaar verwerkt wordt.

### `enrich.js`
Node.js-script voor AI-verrijking van Markdown-documenten. Gebruikt OpenAI's GPT-4o-mini om per document een samenvatting en chronologische tijdlijn te genereren. Bevat ingebouwde rate-limiting, retry-logica en chunking van grote documenten.

### `generate-graph.yml`
GitHub Actions-workflow die `enrich.js` uitvoert. Triggert handmatig en commit de verrijkte Markdown-bestanden terug naar de repository.

### `hugo.toml`
Hugo-configuratie. Definieert de basis-URL, outputformaten (HTML, RSS, JSON) en sitemap-instellingen.

### `index.html`
Startpagina van de website. Laadt Pagefind dynamisch op basis van jaarselectie en biedt een schakelaar naar de CustomGPT AI-assistent. Bevat alle CSS en JavaScript inline.

---

## 6. Configuratie en omgevingsvariabelen <a name="configuratie"></a>

| Variabele | Locatie | Beschrijving |
|-----------|---------|--------------|
| `SYNC_FOLDER` | `deploy.yml` (env) | Naam van de te verwerken jaarmap (bijv. `2024`) |
| `AWS_ACCESS_KEY_ID` | GitHub Secrets | Toegang tot de bronbucket (lezen) |
| `AWS_SECRET_ACCESS_KEY` | GitHub Secrets | Toegang tot de bronbucket (lezen) |
| `AWS_ACCESS_KEY_ID_SITE` | GitHub Secrets | Toegang tot de hostingbucket (schrijven) |
| `AWS_SECRET_ACCESS_KEY_SITE` | GitHub Secrets | Toegang tot de hostingbucket (schrijven) |
| `OPENAI_API_KEY` | GitHub Secrets | OpenAI API-sleutel voor AI-verrijking |
| `MODEL` | `enrich.js` (hardcoded) | OpenAI-model (`gpt-4o-mini`) |
| `MAX_CONCURRENT` | `enrich.js` (hardcoded) | Aantal gelijktijdige AI-verzoeken (standaard: 1) |


