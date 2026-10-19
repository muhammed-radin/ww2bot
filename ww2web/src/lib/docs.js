/**
 * In-app documentation catalogue.
 *
 * The Markdown itself is generated from `docs/` by `npm run sync:docs` and
 * copied to `src/content/docs/` before every build, so the dashboard and the
 * repository can never disagree. Each document is loaded lazily as a raw
 * string; only the small generated manifest is part of the initial bundle.
 */
import manifest from '@/content/docs/index.json';

const rawModules = import.meta.glob('../content/docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: false,
});

/** Documents in curated reading order. */
export const DOCUMENTS = manifest.documents;

/** `[{ label, items: [...] }]`, preserving the manifest order. */
export const DOC_GROUPS = DOCUMENTS.reduce((groups, doc) => {
  const existing = groups.find((group) => group.label === doc.group);
  if (existing) {
    existing.items.push(doc);
  } else {
    groups.push({ label: doc.group, items: [doc] });
  }
  return groups;
}, []);

export function findDocument(id) {
  if (!id) return null;
  const normalised = String(id).toLowerCase();
  return DOCUMENTS.find((doc) => doc.id === normalised) ?? null;
}

/** Load one document's Markdown source. */
export async function loadDocumentSource(doc) {
  if (!doc) throw new Error('Unknown document.');
  const key = Object.keys(rawModules).find((path) => path.endsWith(`/${doc.file}`));
  if (!key) throw new Error(`The source for "${doc.id}" is not available in this build.`);
  return rawModules[key]();
}

export function findNeighbours(doc) {
  const index = DOCUMENTS.findIndex((item) => item.id === doc?.id);
  if (index < 0) return { previous: null, next: null };
  return {
    previous: index > 0 ? DOCUMENTS[index - 1] : null,
    next: index < DOCUMENTS.length - 1 ? DOCUMENTS[index + 1] : null,
  };
}
