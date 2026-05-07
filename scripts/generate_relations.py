import os
import json
import spacy
import frontmatter
import glob
import sys
from collections import Counter

# Laden van het Nederlandse model
try:
    nlp = spacy.load("nl_core_news_lg")
except:
    os.system("python -m spacy download nl_core_news_lg")
    nlp = spacy.load("nl_core_news_lg")

# Alleen relevante labels: PER (Personen), ORG (Organisaties), LOC (Locaties), FAC (Gebouwen/Infrastructuur)
VALID_LABELS = {"PER", "ORG", "LOC", "FAC"}
MIN_OCCURRENCES = 5

def extract_entities(year):
    docs_path = f"docs/{year}/**/*.md"
    output_dir = f"data/{year}"
    os.makedirs(output_dir, exist_ok=True)

    all_entities = []
    documents = []

    print(f"Verwerken van documenten voor {year}...")

    for filepath in glob.iglob(docs_path, recursive=True):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                post = frontmatter.load(f)
                doc_id = os.path.basename(filepath)
                
                # NLP analyse op de tekst (beperkt tot eerste 80k tekens voor snelheid)
                doc = nlp(post.content[:80000])
                
                # Filter direct op labels en lengte
                entities_in_doc = [
                    ent.text.strip().lower() 
                    for ent in doc.ents 
                    if ent.label_ in VALID_LABELS and len(ent.text) > 3
                ]
                
                doc_counts = Counter(entities_in_doc)
                all_entities.extend(entities_in_doc)
                
                documents.append({
                    "id": doc_id,
                    "label": post.get("title", doc_id),
                    "entities": dict(doc_counts)
                })
        except Exception as e:
            print(f"Fout bij {filepath}: {e}")

    # Alleen entiteiten behouden die vaak genoeg voorkomen
    global_counts = Counter(all_entities)
    valid_ents = {e for e, count in global_counts.items() if count >= MIN_OCCURRENCES}

    # Bouw de JSON structuur
    nodes = []
    links = []
    added_topics = set()

    for doc in documents:
        # Voeg document toe als node
        nodes.append({"id": doc["id"], "label": doc["label"], "type": "document", "val": 1})

        for ent_name, count in doc["entities"].items():
            if ent_name in valid_ents:
                ent_id = f"ent_{ent_name.replace(' ', '_')}"
                
                # Voeg stakeholder/plaats toe als node indien nieuw
                if ent_id not in added_topics:
                    nodes.append({
                        "id": ent_id, 
                        "label": ent_name.title(), 
                        "type": "topic", 
                        "val": min(global_counts[ent_name], 50)
                    })
                    added_topics.add(ent_id)

                # Maak de verbinding
                links.append({"source": doc["id"], "target": ent_id, "weight": count})

    with open(f"{output_dir}/relaties.json", "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "links": links}, f, indent=2, ensure_ascii=False)

    print(f"Gereed! Bestand opgeslagen in {output_dir}/relaties.json")

if __name__ == "__main__":
    target_year = sys.argv[1] if len(sys.argv) > 1 else "2024"
    extract_entities(target_year)
