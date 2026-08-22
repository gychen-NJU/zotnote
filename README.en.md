# zotnote 📚 — Zotero Deep-Reading Notes Generator

中文: [README.md](README.md)

**zotnote** is an **Agent Skill** for research literature management (works with DeepSeek Harness, Claude Code, and any agent that understands `SKILL.md`). Pick an article from your **Zotero library**, and zotnote automatically extracts the PDF's **section structure and every figure/table (with captions)**, then generates a **richly illustrated, section-by-section deep-reading note with YAML frontmatter**, mirroring your **Zotero collection tree** into an **Obsidian Vault** for the knowledge graph and citation network.

```
Zotero item ──▶ PDF (local storage first) ──▶ section/figure extraction ──▶ Obsidian note
              zotero.mjs                     extract_pdf.py                vault.mjs / run.mjs
```

## ✨ Features

- **Pick and read**: search Zotero items by title / author / keyword; one command runs the whole pipeline
- **Batch incremental (new!)**: `batch.mjs --collection <dir>` processes *all* articles in a Zotero collection, **auto-skipping those with existing notes** (detected via the `item-key` in Vault note frontmatter — renaming/moving notes never misjudges), idempotent with resume; `--recursive` for sub-collections, `--limit` for batching
- **Illustrated**: auto-locates and crops every figure/table (caption-aware) — raster images by embedded-image bbox, vector figures by drawing-cluster bbox; 300 dpi exports and a manual `crop` subcommand
- **Section-by-section template**: each § reserves *main content / scientific question / methods / properties & conclusions / research value / **key formulas***; each figure reserves *content / panel-by-panel explanation / scientific meaning*, with the original caption quoted
- **Natural language & academic style (new in v0.3.0)**: forced paragraph prose, scholarly wording, consistent terminology, logical connectors, faithful to the source (SKILL.md §7.1) — no placeholder fragments or colloquialisms
- **LaTeX formulas (new in v0.3.0)**: key equations written as inline `$…$` / display `$$…$$`, verified with the §7.3 checklist before delivery (dollar pairing, unit escaping, Greek-letter commands); `vault.mjs` warns on unbalanced `$`
- **Knowledge-graph ready**: YAML frontmatter (title/authors/year/journal/doi/dual Zotero links/collections/tags/status) + `[[wikilink]]` relationship section
- **Mirrored layout**: `<Vault>/Zotero Notes/<collection path...>/<short-title year>/`, one-to-one with your Zotero tree; images under `assets/<itemKey>/`
- **Safe writes**: never overwrites existing notes (date-suffixed copies); offline-capable with local PDFs

## 🚀 Quick Start

### 1. Dependencies

```bash
pip install pymupdf        # figure/text extraction (required)
# Node.js >= 22 (scripts only, no npm install needed)
```

### 2. Configure

Edit `~/.config/zotnote/config.json`:

```json
{
  "installDir": "<absolute path to this repo>",
  "zotero": {
    "apiKey": "your-zotero-api-key",
    "userID": 123456,
    "storagePath": "E:/software/Zotero/Zotero/storage"
  },
  "obsidian": {
    "vaultRoot": "C:/Users/you/Documents/Obsidian Vault",
    "notesRoot": "Zotero Notes"
  },
  "pythonCmd": "python"
}
```

- API key: create one at <https://www.zotero.org/settings/keys> (read access is enough)
- `storagePath`: the `storage` subdirectory of your Zotero data directory; leave empty to download via the Zotero Web API
- Verify: `node scripts/zotero.mjs --mode verify`

### 3. Use

```bash
# ① find an item
node scripts/zotero.mjs --mode search --query "white-light flare"
# ② generate the note skeleton in one shot (add --dry-run to preview)
node scripts/run.mjs --key MYBFJAXP
# ③ batch incremental: process a whole collection, skipping notes already built
node scripts/batch.mjs --collection "works" --recursive --dry-run   # preview first
node scripts/batch.mjs --collection "works" --recursive --limit 5   # 5 per batch
```

Then open the note and replace the `<!-- … -->` placeholders with your reading.

## 🧩 Design

| File | Purpose |
|---|---|
| `SKILL.md` | Agent instructions (triggers: Zotero deep-read / paper reading notes / illustrated notes / Obsidian knowledge graph) |
| `scripts/zotero.mjs` | Zotero Web API client: search / info / tree / pdf (local first, web fallback) |
| `scripts/extract_pdf.py` | PyMuPDF extractor: heading detection (font-size + numbering + word list, noise-filtered), caption localization, raster/vector cropping, manual `crop` subcommand |
| `scripts/vault.mjs` | Obsidian writer: mirrored directories, asset copy, frontmatter + deep-read template, collision-safe |
| `scripts/run.mjs` | One-shot pipeline orchestrator |
| `scripts/batch.mjs` | Batch incremental: whole-collection processing with skip-detection & manifest |

### Extraction principles

1. **Sections**: font-size clustering + `^\d+(\.\d+)*` numbering + standard heading words (Abstract/Introduction/Methods/Results/…); merges split "1." + "Introduction" layouts; filters timestamps, axis ticks, affiliations, and `(a)/(b)` panel labels.
2. **Figures/tables**: caption regex (`Figure/Table/图/表 N`) → ① raster images above the caption in the same column (horizontal/vertical panels auto-merged) → ② vector figures via `get_drawings()` clusters → ③ text-gap fallback. 200 dpi by default, adjustable with `--dpi`.
3. **Notes**: frontmatter carries `zotero://select` + zotero.org dual links; `collections` mirrors the Zotero chain; body follows the five-question template (what problem / how / properties / value / future directions & frontier links).

## 📂 Example output

```
Obsidian Vault/
└── Zotero Notes/
    └── works/
        └── 2025_Spectropolarimetry/
            └── Stokes Inversion ...
                ├── Stokes Inversion ....md      ← deep-reading note
                └── assets/
                    └── ABCD1234/
                        ├── figure-1-p3.png
                        ├── figure-2-p5.png
                        └── table-1-p7.png
```

## ❓ FAQ

- **Odd caption placement / bad crop** → `python scripts/extract_pdf.py crop <pdf> --out x.png --page 21 --rect "x0,y0,x1,y1" --dpi 300`
- **No local Zotero** → leave `storagePath` empty; PDFs come from the web API
- **Different vault layout** → tune `--notes-relative-root` / `--assets`
- **Relationship to arxiv-checkup** → complementary: arxiv-checkup archives, zotnote deep-reads

## 📄 License

MIT © 2026 gychen-NJU
