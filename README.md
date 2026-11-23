# Accessible PDF Export

Export a note as a tagged PDF built to pass PDF/UA-1 checks, so people using screen readers get the headings, lists, tables, links and image descriptions in the right order.

Obsidian's built-in **Export to PDF** produces untagged PDFs: no structure, no document language and no PDF/UA marker. A screen reader finds no headings, lists or table structure to move through, and checkers such as veraPDF and PAC fail them. Accessible PDF Export keeps Obsidian's rendering of your note and adds the structure those tools look for.

## Use it

- Open a note, then run **Accessible PDF Export: Export current note to accessible PDF** from the command palette.
- Or right-click a note in the file explorer and choose the export item.

The PDF is saved next to the note, with the same name. Exporting again replaces a PDF this plugin made. If a different file already has that name, it is left alone and the export is saved as `Note (accessible).pdf`. You can choose to be asked where to save each time instead. The PDF then goes in the folder you pick, which must be inside this vault.

## What the PDF contains

- Headings, paragraphs, lists, tables (with header cells), code blocks, quotes and callouts, tagged in reading order.
- Headings in order, starting at level 1. With **Note name as title** on, the note name is the first heading.
- Links to websites and to headings in the same note, each with a description. Links to other notes in the vault become plain text, because they point nowhere outside Obsidian.
- Images from the vault, embedded in the file, with the description you wrote in the note.
- Document title, language and the PDF/UA-1 identifier in the file's metadata.
- Backgrounds, borders and other decoration marked so screen readers skip them.

Note properties (front matter), copy buttons and fold arrows are left out.

## How we checked it

We exported 20 public notes from the Obsidian help and developer docs (headings, tables, images, lists, links, code) on Obsidian 1.14.4 for Linux.

- Obsidian's built-in Export to PDF: 0 of 20 passed veraPDF 1.30.3 (PDF/UA-1) and 0 of 20 passed PAC 2024.
- Accessible PDF Export 0.1.0, default settings: 20 of 20 passed veraPDF 1.30.3 (PDF/UA-1) and 20 of 20 passed PAC 2024.

A passing check is not the same as a good reading experience. We have not yet tested these PDFs with a screen reader.

## Check the reading order

Download the [example PDF](./examples/reading-order.pdf?raw=true), exported with Accessible PDF Export 0.1.1 on Linux. Open a terminal in the download folder with [Poppler's pdfinfo](https://manpages.debian.org/trixie/poppler-utils/pdfinfo.1.en.html#OPTIONS) installed (the `poppler-utils` package on Debian). Run:

```sh
pdfinfo -struct-text "reading-order.pdf"
```

Look for these entries in order:

1. `H1` "Reading order example"
2. `H2` "Library hours"
3. `Table` with "Day" and "Opens" as headers, then "Tuesday" and "Thursday" as the rows
4. `H2` "Further reading"
5. `Link` "PDF reading order guide"

For your own export, replace `reading-order.pdf` with its filename. Follow the tag tree from top to bottom and compare the headings, table rows and links with the order you intended.

## Settings

- **Page size:** A4, Letter or Legal.
- **Document language:** the language code screen readers use, such as `en`, `de` or `pt-BR`. A `lang` or `language` property in the note takes precedence.
- **Note name as title:** print the note name as the first heading.
- **Where to save:** next to the note, or ask each time (a folder inside this vault).

## Get good results

- Describe every image: `![A table view listing books by author](books.png)`. Without a description, the PDF carries whatever Obsidian gives the image, often its file name, and that is what a screen reader will say.
- Use headings in order, and give tables a header row.
- Set `lang` in the note's properties when a note is not in your default language.

## Limits

- Desktop only. Tested on Obsidian 1.14.4 for Linux. Windows and macOS have not been tested yet.
- One note at a time. No folder or vault export.
- While it exports, the plugin writes the page it prints as a hidden file in its own folder, `.obsidian/plugins/accessible-pdf-export/`, and deletes it as soon as the page has loaded.
- Not yet tested on notes with math, embedded notes beyond simple cases, or Mermaid diagrams. If the vault has not allowed Mermaid, the diagram source prints as code.
- The PDF uses Obsidian's print styles and your theme's colours. Check contrast if your theme is dark or low-contrast.
- PDF/UA-1 covers the file's structure. It does not check whether your image descriptions, link text or headings make sense; that part is yours.

## Privacy

No telemetry. No account. The plugin has no server of its own and does not upload your notes. It reads the note and its images from your vault and writes one PDF file to the folder you choose.

The export renders your note the way Obsidian shows it. If the note or your theme uses images, fonts or other content from the web, such as an embedded video, the export loads them too, and the sites that host them see that request, as they do when Obsidian shows the note.

## Install

In Obsidian, open **Settings → Community plugins**. If Restricted mode is on, select **Exit Restricted mode**. Select **Browse**, search for "Accessible PDF Export", then select **Install** and **Enable**.

If it is not listed there yet, install it by hand:

1. Download `main.js` and `manifest.json` from the latest release of this repository.
2. In your vault, create the folder `.obsidian/plugins/accessible-pdf-export/` and put both files in it. The `.obsidian` folder is hidden on most systems.
3. In Obsidian, open **Settings → Community plugins**. If Restricted mode is on, select **Exit Restricted mode**. Next to "Installed plugins", select the reload icon (**Reload plugins**), then turn on **Accessible PDF Export**.

## Already have a PDF?

For a PDF that did not come from Obsidian, we also run a free web checker at [cybernative.ai/tagged-pdfs/check](https://cybernative.ai/tagged-pdfs/check/). It reports PDF/UA problems in plain language at no cost. The same page sells PDF tagging; the plugin does not use or contact it.

## Feedback

Please open an issue on this repository. Include your Obsidian version, operating system and what the checker or screen reader reported. Do not attach private notes.

## License

MIT. Made by [CyberNative AI LLC](https://cybernative.ai), an AI-run company with one human founder.
