"""
Genera el GDD de "Código de Barras" (.docx + .pdf) usando la skill game-design-document.

Uso:
    ../../.claude/skills/game-design-document/.venv/bin/python build_gdd.py

El contenido vive en gdd_content.py; este script solo traduce los títulos de sección
al español, quita la sección de monetización (proyecto personal) y llama a los generadores.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.abspath(os.path.join(HERE, "..", "..", ".claude", "skills", "game-design-document", "scripts"))
sys.path.insert(0, SKILL)
sys.path.insert(0, HERE)

from utils import section_registry as reg  # noqa: E402

NOMBRES_ES = {
    "cover_page": "Portada",
    "executive_summary": "Resumen ejecutivo",
    "game_overview": "Visión general",
    "core_gameplay_loop": "Core loop",
    "game_mechanics": "Mecánicas",
    "progression_system": "Progresión",
    "content_design": "Contenido",
    "narrative_world": "Narrativa y mundo",
    "ux_interface": "Experiencia de usuario e interfaz",
    "art_direction": "Dirección de arte",
    "audio_design": "Audio",
    "multiplayer_design": "Multijugador cooperativo",
    "economy_design": "Economía",
    "technical_requirements": "Requisitos técnicos",
    "competitive_analysis": "Juegos de referencia",
    "development_roadmap": "Roadmap de desarrollo",
    "risk_assessment": "Riesgos",
    "appendices": "Apéndices",
}

# Proyecto personal: sin monetización ni portada como sección aparte (la portada la genera el script).
for quitar in ("monetization_strategy", "cover_page"):
    if quitar in reg.SECTION_ORDER:
        reg.SECTION_ORDER.remove(quitar)

for n, key in enumerate(reg.SECTION_ORDER, start=1):
    reg.SECTIONS[key]["name"] = NOMBRES_ES.get(key, reg.SECTIONS[key]["name"])
    reg.SECTIONS[key]["order"] = n

from gdd_content import GAME  # noqa: E402
import generate_gdd_docx  # noqa: E402

# El generador de PDF ignora las subsecciones, así que se aplanan a "## título" en el texto.
for key, val in list(GAME["sections"].items()):
    if isinstance(val, dict):
        partes = [val.get("content", "")]
        for sub in val.get("subsections", []):
            partes.append(f"## {sub['title']}\n{sub['content']}")
        GAME["sections"][key] = "\n\n".join(p for p in partes if p)

out = os.path.join(HERE, "output")
os.makedirs(out, exist_ok=True)

with open(os.path.join(HERE, "game_config.json"), "w", encoding="utf-8") as f:
    json.dump(GAME, f, ensure_ascii=False, indent=2)

generate_gdd_docx.generate_gdd_docx(GAME, os.path.join(out, "CodigoDeBarras_GDD_v0.1.docx"),
                                    include_template_sections=False)
# PDF: se convierte el .docx con LibreOffice (las tablas del generador fpdf cortan el texto).
import subprocess  # noqa: E402
subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", out,
                os.path.join(out, "CodigoDeBarras_GDD_v0.1.docx")], check=True)
