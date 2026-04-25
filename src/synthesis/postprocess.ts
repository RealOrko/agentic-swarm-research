/**
 * Deterministic post-processing for synthesizer output.
 *
 * The LLM-generated report's "Sources" section is unreliable: same prompt,
 * same inputs, different temperatures of luck — sometimes deduped, sometimes
 * not. This module enforces dedup as a final pass so reliability doesn't
 * depend on stochastic prompt obedience.
 */

const HEADING_RE = /^(#+)\s+(.+?)\s*$/;
const SOURCES_HEADING_RE = /^sources?$/i;
const NUMBERED_ITEM_RE = /^(\d+)\.\s+(.+)$/;
const URL_RE = /https?:\/\/[^\s)\]>"']+/;
const BACKTICK_RE = /`([^`]+)`/;

/**
 * Normalize a source-list item to a comparison key.
 * - URL: parsed, lowercased host, fragment + tracking params stripped, trailing / removed.
 * - Backtick path: contents lowercased, trailing / removed.
 * - Else: whitespace-collapsed lowercase.
 */
function normalizeKey(itemText: string): string {
  const urlMatch = itemText.match(URL_RE);
  if (urlMatch) {
    try {
      const u = new URL(urlMatch[0]);
      u.hash = "";
      const drop: string[] = [];
      u.searchParams.forEach((_v, k) => {
        if (/^utm_|^ref$|^src$|^source$/i.test(k)) drop.push(k);
      });
      for (const k of drop) u.searchParams.delete(k);
      return u.toString().replace(/\/+$/, "").toLowerCase();
    } catch {
      // Fall through to other strategies on malformed URL
    }
  }
  const codeMatch = itemText.match(BACKTICK_RE);
  if (codeMatch) {
    return codeMatch[1].trim().replace(/\/+$/, "").toLowerCase();
  }
  return itemText.trim().toLowerCase().replace(/\s+/g, " ");
}

interface ParsedItem {
  /** Lines that make up this item (numbered first line + continuation lines). */
  lines: string[];
  /** Normalized key for dedup. */
  key: string;
}

/**
 * Find the LAST "Sources" heading in the report and dedupe its numbered items.
 * Items are deduped by normalizeKey; the first occurrence's display text is kept.
 * Returns the rewritten report and the count of duplicate entries removed.
 */
export function dedupeSources(report: string): { result: string; deduped: number } {
  const lines = report.split("\n");

  // Locate the LAST sources heading.
  let sourcesStart = -1;
  let sourcesLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && SOURCES_HEADING_RE.test(m[2])) {
      sourcesStart = i;
      sourcesLevel = m[1].length;
    }
  }
  if (sourcesStart === -1) return { result: report, deduped: 0 };

  // Find end of section: next same-or-shallower heading, or EOF.
  let sourcesEnd = lines.length;
  for (let i = sourcesStart + 1; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].length <= sourcesLevel) {
      sourcesEnd = i;
      break;
    }
  }

  // Walk the section: leading non-item lines → numbered items (with continuations) → trailing non-item lines.
  let i = sourcesStart + 1;
  const leadingLines: string[] = [];
  while (i < sourcesEnd && !NUMBERED_ITEM_RE.test(lines[i])) {
    leadingLines.push(lines[i]);
    i++;
  }

  const items: ParsedItem[] = [];
  while (i < sourcesEnd) {
    const m = lines[i].match(NUMBERED_ITEM_RE);
    if (!m) break;
    const itemLines = [lines[i]];
    const itemBody = m[2];
    i++;
    // Continuation lines: non-blank, non-numbered.
    while (i < sourcesEnd && !NUMBERED_ITEM_RE.test(lines[i]) && lines[i].trim() !== "") {
      itemLines.push(lines[i]);
      i++;
    }
    items.push({ lines: itemLines, key: normalizeKey(itemBody) });
    // Skip blank separator lines between items.
    while (i < sourcesEnd && lines[i].trim() === "") i++;
  }

  const trailingLines: string[] = [];
  while (i < sourcesEnd) {
    trailingLines.push(lines[i]);
    i++;
  }

  // Dedupe by key, preserving first occurrence's text.
  const seen = new Set<string>();
  const dedupedItems: ParsedItem[] = [];
  let deduped = 0;
  for (const item of items) {
    if (seen.has(item.key)) {
      deduped += 1;
      continue;
    }
    seen.add(item.key);
    dedupedItems.push(item);
  }

  if (deduped === 0) return { result: report, deduped: 0 };

  // Renumber and rebuild.
  const newSection: string[] = [...leadingLines];
  for (let idx = 0; idx < dedupedItems.length; idx++) {
    const item = dedupedItems[idx];
    const renumbered = item.lines[0].replace(/^\d+\./, `${idx + 1}.`);
    newSection.push(renumbered);
    for (let j = 1; j < item.lines.length; j++) newSection.push(item.lines[j]);
  }
  newSection.push(...trailingLines);

  const rebuilt = [
    ...lines.slice(0, sourcesStart + 1),
    ...newSection,
    ...lines.slice(sourcesEnd),
  ];

  return { result: rebuilt.join("\n"), deduped };
}
