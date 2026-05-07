import os
import json
import spacy
import frontmatter
import glob
import sys
import re

from collections import Counter, defaultdict

# Nederlands model laden
try:
    nlp = spacy.load("nl_core_news_lg")
except:
    os.system("python -m spacy download nl_core_news_lg")
    nlp = spacy.load("nl_core_news_lg")

# Extra irrelevante woorden
CUSTOM_STOPWORDS = {
    "pagina", "datum", "onderwerp", "bijlage",
    "kenmerk", "geachte", "besluit", "artikel",
    "verzoek", "woo", "wob", "college",
    "gemeente", "gemeente coevorden",
    "zaak", "nummer", "zienswijze"
}

# Alleen deze entity types
VALID_LABELS = {"PER", "ORG", "LOC", "FAC"}

MIN_ENTITY_OCCURRENCES = 5
MAX_DOC_CHARS = 80000


def normalize_entity(text):
    """
    Maak entiteiten consistenter.
    """

    text = text.strip().lower()

    # verwijder rare OCR tekens
    text = re.sub(r"[^\w\s\-]", "", text)

    # meerdere spaties weg
    text = re.sub(r"\s+", " ", text)

    return text


def is_valid_entity(ent_text):
    """
    Filter slechte entiteiten eruit.
    """

    if len(ent_text) < 4:
        return False

    if ent_text in CUSTOM_STOPWORDS:
        return False

    if any(char.isdigit() for char in ent_text):
        return False

    if ent_text.startswith("sab"):
        return False

    return True


def extract_entities(year):

    docs_path = f"docs/{year}/**/*.md"
    output_dir = f"data/{year}"

    os.makedirs(output_dir, exist_ok=True)

    all_entities = []
    documents = []

    print(f"Scannen documenten voor {year}...")

    for filepath in glob.iglob(docs_path, recursive=True):

        try:

            with open(filepath, "r", encoding="utf-8") as f:

                post = frontmatter.load(f)

                doc_id = os.path.basename(filepath)

                title = post.get("title", doc_id)

                content = post.content[:MAX_DOC_CHARS]

                doc = nlp(content)

                entity_counter = Counter()

                for ent in doc.ents:

                    if ent.label_ not in VALID_LABELS:
                        continue

                    normalized = normalize_entity(ent.text)

                    if not is_valid_entity(normalized):
                        continue

                    entity_counter[normalized] += 1
                    all_entities.append(normalized)

                documents.append({
                    "id": doc_id,
                    "label": title,
                    "entities": dict(entity_counter)
                })

        except Exception as e:
            print(f"Fout in {filepath}: {e}")

    print("Frequenties berekenen...")

    global_counts = Counter(all_entities)

    valid_entities = {
        ent for ent, count in global_counts.items()
        if count >= MIN_ENTITY_OCCURRENCES
    }

    nodes = []
    links = []

    added_entities = set()

    print("Graph bouwen...")

    for doc in documents:

        # document node
        nodes.append({
            "id": doc["id"],
            "label": doc["label"],
            "type": "document",
            "val": 1
        })

        for entity_name, local_count in doc["entities"].items():

            if entity_name not in valid_entities:
                continue

            ent_id = f"ent_{entity_name.replace(' ', '_')}"

            global_count = global_counts[entity_name]

            # onderwerp node
            if ent_id not in added_entities:

                nodes.append({
                    "id": ent_id,
                    "label": entity_name.title(),
                    "type": "topic",

                    # BELANGRIJK:
                    # grootte van node in ForceGraph
                    "val": min(global_count, 50),

                    "count": global_count
                })

                added_entities.add(ent_id)

            # verbinding document -> onderwerp
            links.append({
                "source": doc["id"],
                "target": ent_id,

                # dikkere lijnen bij vaker voorkomen
                "weight": local_count,

                "relation": "vermeldt"
            })

    result = {
        "nodes": nodes,
        "links": links
    }

    output_file = f"{output_dir}/relaties.json"

    with open(output_file, "w", encoding="utf-8") as out:
        json.dump(result, out, indent=2, ensure_ascii=False)

    print(f"Klaar: {output_file}")


if __name__ == "__main__":

    target_year = sys.argv[1] if len(sys.argv) > 1 else "2024"

    extract_entities(target_year)
