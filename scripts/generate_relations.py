import os
import json
import spacy
import frontmatter
import glob
import sys

# Laad het Nederlandse model (groot model voor betere accuratesse)
# Installatie: python -m spacy download nl_core_news_lg
try:
    nlp = spacy.load("nl_core_news_lg")
except:
    os.system("python -m spacy download nl_core_news_lg")
    nlp = spacy.load("nl_core_news_lg")

def extract_entities(year):
    docs_path = f"docs/{year}/**/*.md"
    output_dir = f"data/{year}"
    os.makedirs(output_dir, exist_ok=True)

    nodes = []
    links = []
    seen_entities = {}

    # Scan alle markdown files
    for filepath in glob.iglob(docs_path, recursive=True):
        with open(filepath, 'r', encoding='utf-8') as f:
            post = frontmatter.load(f)
            doc_id = os.path.basename(filepath)
            
            # Voeg het document zelf toe als node
            nodes.append({"id": doc_id, "type": "document", "label": post.get('title', doc_id)})

            # Analyseer de tekst
            doc = nlp(post.content)
            
            # Haal entiteiten op (Personen, Organisaties, Producten/Objecten)
            for ent in doc.ents:
                if ent.label_ in ["PER", "ORG", "PRODUCT", "FAC"]:
                    ent_name = ent.text.strip().replace("\n", " ")
                    
                    if len(ent_name) < 3: continue # Filter ruis

                    ent_id = f"ent_{ent_name.lower().replace(' ', '_')}"
                    
                    if ent_id not in seen_entities:
                        seen_entities[ent_id] = True
                        nodes.append({
                            "id": ent_id,
                            "type": ent.label_,
                            "label": ent_name
                        })
                    
                    # Maak de verbinding tussen document en entiteit
                    links.append({
                        "source": doc_id,
                        "target": ent_id,
                        "relation": "vermeldt"
                    })

    # Opslaan als JSON
    result = {"nodes": nodes, "links": links}
    with open(f"{output_dir}/relaties.json", 'w', encoding='utf-8') as out:
        json.dump(result, out, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    target_year = sys.argv[1] if len(sys.argv) > 1 else "2024"
    extract_entities(target_year)
