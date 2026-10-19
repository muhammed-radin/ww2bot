#!/usr/bin/env node
/**
 * Publish the repository documentation into the dashboard.
 *
 * `docs/*.md` is the single source of truth for the written documentation. The
 * dashboard renders it at `#/docs`, so the Markdown is copied verbatim into
 * `ww2web/src/content/docs/` together with a generated `index.json` manifest
 * (title, description, reading order and group).
 *
 * The copy is generated, never hand-edited, and refreshed automatically before
 * every frontend build (`npm run build:frontend`). Running it on its own is for
 * frontend development:
 *
 *   npm run sync:docs
 *
 * Nothing here reads the environment, the data directory or any secret; only
 * the Markdown under `docs/` is touched.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../src/utils/isMain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
export const DOCS_SOURCE = path.join(REPO_ROOT, 'docs');
export const DOCS_TARGET = path.join(REPO_ROOT, 'ww2web/src/content/docs');

/**
 * Reading order and grouping, mirroring `docs/README.md`. A document that is
 * not listed here is still published — it is appended under "More" — so adding
 * a file to `docs/` can never silently drop it from the dashboard.
 */
const CATALOGUE = [
  { id: 'getting-started', group: 'Start here' },
  { id: 'configuration', group: 'Start here' },
  { id: 'architecture', group: 'Start here' },
  { id: 'admin-dashboard', group: 'Start here' },
  { id: 'authentication', group: 'API and connectors' },
  { id: 'api-reference', group: 'API and connectors' },
  { id: 'connectors', group: 'API and connectors' },
  { id: 'connection-lifecycle', group: 'API and connectors' },
  { id: 'outbound-messaging', group: 'API and connectors' },
  { id: 'webhooks', group: 'API and connectors' },
  { id: 'realtime-events', group: 'API and connectors' },
  { id: 'storage', group: 'Data, security and operations' },
  { id: 'data-retention', group: 'Data, security and operations' },
  { id: 'security', group: 'Data, security and operations' },
  { id: 'operations', group: 'Data, security and operations' },
  { id: 'deployment', group: 'Data, security and operations' },
  { id: 'testing', group: 'Data, security and operations' },
  { id: 'scripts', group: 'Data, security and operations' },
  { id: 'development', group: 'Data, security and operations' },
  { id: 'errors', group: 'Data, security and operations' },
  { id: 'readme', group: 'Reference index' },
];

const CATALOGUE_INDEX = new Map(CATALOGUE.map((entry, index) => [entry.id, { ...entry, order: index }]));
const DEFAULT_ORDER = CATALOGUE.length;

/** `README.md` -> `readme`, `API-Reference.md` -> `api-reference`. */
function toDocumentId(filename) {
  return filename.replace(/\.md$/i, '').toLowerCase();
}

/** First ATX heading, which every document in `docs/` has. */
function extractTitle(markdown, fallback) {
  const match = markdown.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return match ? stripInline(match[1]) : fallback;
}

/**
 * The first real prose block, used as the listing description.
 *
 * Documents are split into blank-line-separated blocks. Headings, tables,
 * blockquotes, code fences and horizontal rules are skipped; a document that
 * opens with a list (such as `architecture.md`) falls back to its first item,
 * which is still far better than a mid-sentence fragment.
 */
function extractDescription(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = [];
  let inFence = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  for (const block of blocks) {
    const first = block[0].trim();
    if (/^#{1,6}\s/.test(first)) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(first)) continue;
    if (first.startsWith('|') || first.startsWith('>')) continue;

    if (/^([-*+]|\d+[.)])\s/.test(first)) {
      const item = [];
      for (const line of block) {
        if (item.length > 0 && /^\s*([-*+]|\d+[.)])\s/.test(line)) break;
        item.push(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      }
      return shorten(stripInline(item.join(' ')));
    }

    return shorten(stripInline(block.join(' ')));
  }
  return '';
}

function shorten(text) {
  const normalised = text.replace(/\s+/g, ' ').trim();
  return normalised.length > 220 ? `${normalised.slice(0, 217).trimEnd()}…` : normalised;
}

/** Remove the inline Markdown that would be noise in a one-line description. */
function stripInline(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Rebuild `ww2web/src/content/docs` from `docs/`.
 * @returns {Promise<{count: number, target: string, manifest: object[]}>}
 */
export async function syncDocs({ logger = console } = {}) {
  let filenames;
  try {
    filenames = (await fs.readdir(DOCS_SOURCE)).filter((name) => name.toLowerCase().endsWith('.md')).sort();
  } catch (error) {
    throw new Error(`cannot read ${DOCS_SOURCE}: ${error.message}`);
  }
  if (filenames.length === 0) {
    throw new Error(`no Markdown files found in ${DOCS_SOURCE}`);
  }

  const documents = [];
  for (const filename of filenames) {
    const markdown = await fs.readFile(path.join(DOCS_SOURCE, filename), 'utf8');
    const id = toDocumentId(filename);
    const catalogue = CATALOGUE_INDEX.get(id);
    documents.push({
      id,
      file: `${id}.md`,
      source: filename,
      title: extractTitle(markdown, id),
      description: extractDescription(markdown),
      group: catalogue?.group ?? 'More',
      order: catalogue?.order ?? DEFAULT_ORDER,
      lines: markdown.split('\n').length,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      markdown,
    });
  }

  documents.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)));

  // Rebuild rather than merge, so a document deleted from `docs/` cannot linger
  // in the dashboard. The directory is generated output and holds nothing else.
  await fs.rm(DOCS_TARGET, { recursive: true, force: true });
  await fs.mkdir(DOCS_TARGET, { recursive: true });

  for (const document of documents) {
    await fs.writeFile(path.join(DOCS_TARGET, document.file), document.markdown, 'utf8');
  }

  const manifest = documents.map(({ markdown, source, ...meta }) => meta);
  await fs.writeFile(
    path.join(DOCS_TARGET, 'index.json'),
    `${JSON.stringify({ generated: true, source: 'docs/', documents: manifest }, null, 2)}\n`,
    'utf8',
  );

  logger?.log?.(`[sync:docs] published ${documents.length} document(s) to ${path.relative(REPO_ROOT, DOCS_TARGET)}`);
  return { count: documents.length, target: DOCS_TARGET, manifest };
}

if (isMainModule(import.meta.url)) {
  syncDocs().catch((error) => {
    process.stderr.write(`[sync:docs] error: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
