import ollama
import json

prompt = f"""
Haal stakeholders en locaties uit deze tekst.

Geef ALLEEN JSON terug:

{{
  "stakeholders": [],
  "locations": []
}}

Tekst:
{content[:12000]}
"""

response = ollama.chat(
    model='llama3',
    messages=[{
        'role': 'user',
        'content': prompt
    }]
)

data = json.loads(response['message']['content'])
