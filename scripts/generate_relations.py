import os
import json
import spacy
import frontmatter
import glob
import sys
from collections import Counter

# Laad het Nederlandse model
try:
    nlp = spacy.load("nl_core_news_lg")
except:
    os.system("python -m spacy download nl_core_news_lg")
    nlp = spacy.load("nl_core_news_lg")

# Handmatige lijst met woorden die vaak door OCR fout gaan of niet relevant zijn in WOO context
CUSTOM_STOPWORDS = {
    "sab", "pagina", "datum", "onderwerp", "bijlage", "kenmerk", "geachte", "besluit", 
    "art.", "artikel", "verzoek", "woo", "wob", "kenmerk:", "kenmerk", "gezien"
}

def clean_text(text):
    """Verwijder vreemde tekens die vaak voorkomen in OCR van PDF's"""
    return text.replace("\n", " ").replace("\\", "").strip()

def extract_entities(year):
    docs_path = f"docs/{year}/**/*.md"
    output_dir = f"data/{year}"
    os.makedirs(output_dir, exist_ok=True)

    all_found_entities = [] # Lijst voor alle PER, ORG, LOC, FAC gevonden in de set
    doc_data = [] # Tijdelijke opslag van doc -> entiteiten relaties

    # STAP 1: Scan alle bestanden en verzamel entiteiten
    print(f"Scannen van documenten voor jaar {year}...")
    for filepath in glob.iglob(docs_path, recursive=True):
        with open(filepath, 'r', encoding='utf-8') as f:
            try:
                post = frontmatter.load(f)
                doc_id = os.path.basename(filepath)
                doc_title = post.get('title', doc_id)
                
                # Analyseer tekst
                doc = nlp(post.content[:100000]) # Limiet per doc voor snelheid
                
                current_doc_entities = []
                for ent in doc.ents:
                    # Filter op Type (Persoon, Organisatie, Locatie, Gebouw)
                    # En filter op stopwoorden en lengte
                    label_low = ent.text.lower().strip()
                    if (ent.label_ in ["PER", "ORG", "LOC", "FAC"]) and \
                       (len(label_low) > 3) and \
                       (not label_low.startswith('sab')) and \
                       (label_low not in CUSTOM_STOPWORDS) and \
                       (not any(char.isdigit() for char in label_low)): # Geen getallen/codes
                        
                        clean_name = ent.text.strip().replace('"', '')
                        all_found_entities.append(clean_name)
                        current_doc_entities.append(clean_name)
                
                doc_data.append({
                    "id": doc_id,
                    "label": doc_title,
                    "entities": list(set(current_doc_entities))
                })
            except Exception as e:
                print(f"Fout bij verwerken {filepath}: {e}")

    # STAP 2: Tel frequentie en filter op > 10
    counts = Counter(all_found_entities)
    valid_entities = {name for name, count in counts.items() if count >= 10}
    print(f"Totaal unieke entiteiten: {len(counts)}. Na filtering (>10x): {len(valid_entities)}")

    # STAP 3: Bouw de finale JSON
    nodes = []
    links = []
    added_entity_nodes = set()

    for doc in doc_data:
        # Voeg document toe als node
        nodes.append({"id": doc["id"], "type": "document", "label": doc["label"]})
        
        for ent_name in doc["entities"]:
            if ent_name in valid_entities:
                ent_id = f"ent_{ent_name.lower().replace(' ', '_')}"
                
                # Voeg entiteit node toe (slechts één keer)
                if ent_id not in added_entity_nodes:
                    nodes.append({
                        "id": ent_id,
                        "type": "topic",
                        "label": ent_name,
                        "count": counts[ent_name] # Handig voor grootte van bolletje in UI
                    })
                    added_entity_nodes.add(ent_id)
                
                # Leg link
                links.append({
                    "source": doc["id"],
                    "target": ent_id,
                    "relation": "vermeldt"
                })

    # STAP 4: Opslaan
    result = {"nodes": nodes, "links": links}
    with open(f"{output_dir}/relaties.json", 'w', encoding='utf-8') as out:
        json.dump(result, out, indent=2, ensure_ascii=False)
    print(f"Succes! relaties.json gegenereerd in {output_dir}")

if __name__ == "__main__":
    target_year = sys.argv[1] if len(sys.argv) > 1 else "2024"
    extract_entities(target_year)
