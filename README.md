# micro-paper

**English** | [简体中文](README.zh-CN.md)

Turn an English paper PDF into an offline English–Chinese HTML reader. **Read the text on the left, with the matching figure in view on the right.**

## Five features

### 1. Text and figures stay in sync as you read

On desktop, the text and figures have separate panels. As you read past a figure reference, the figure panel switches to the corresponding image, so you can keep reading with the relevant figure in view.

### 2. Compare the original, translation, and captions

Read the English text alongside its Chinese translation, paragraph by paragraph, with complete bilingual figure captions. Labels within the original images stay in English.

### 3. Navigate the paper’s own structure

The collapsible table of contents follows the paper’s own sections, such as the abstract, introduction, methods, results, and discussion. Expand a section or jump straight to the part you want to study.

### 4. Keep your notes as you read

Use five highlight colors, add notes, adjust the reading font size, and search both English and Chinese. Back up notes as JSON, export them as Markdown, or include them in a downloaded copy of the HTML reader.

### 5. Check the source when you need it

Open the complete original PDF, jump from a passage to its source page, or follow a verified citation number to its reference entry. Citation links are added only when supported by the source.

## Install

Give the repository URL to your Agent:

```text
Please install this Skill: https://github.com/Microlightt/micro-paper
```

Or install with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add Microlightt/micro-paper --skill micro-paper
```

No extra initialization or separate API key is required for this Skill.

## Usage

Provide an English paper PDF and ask your Agent:

```text
Use $micro-paper to turn this paper into a complete, faithful offline English–Chinese HTML reader.
Keep the original figures, full bilingual captions, and complete original PDF.
Check the source, translation, and reading interactions. Save all outputs in a new, separate working directory,
and report the review scope and anything still incomplete.
```

You receive an offline `reader.html`, plus `paper.json`, source records, and a separate QA report for rebuilding and checking the reader. Existing readers can also be revised; back up your notes first.

## Requirements and privacy

- Creating a reader requires Python 3.10+ with `pdfplumber`, `pypdfium2`, and `Pillow`; Node.js 18+; and an Agent that can inspect source pages and operate a real browser. The workflow has been run locally on macOS; Windows and Linux have not been tested on actual machines.
- The finished reader works offline. During creation, paper content may be processed by the Agent host and model services you use. Downloaded HTML contains the complete PDF and may include your notes; check its contents before sharing.
- The Agent performs translation and scientific review. Technical checks cannot replace a full scientific review. See the [QA guide (Chinese)](references/qa.md) for test commands, the 22 required technical checks, and troubleshooting; see [SKILL.md (Chinese)](SKILL.md) for the full workflow.
- Keep real papers, notes, and run records outside the repository. This Skill does not download papers automatically or host readers publicly.

Current version: **v1.6.0** · [MIT License](LICENSE)
