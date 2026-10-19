/**
 * Entry-point detection.
 *
 * The naive check `import.meta.url === \`file://${process.argv[1]}\`` breaks
 * whenever the script path contains characters that `import.meta.url`
 * percent-encodes — for example a space, as in "Radin Workspace". The correct
 * comparison encodes the path with the same rules using pathToFileURL.
 */
import { pathToFileURL } from 'node:url';

/**
 * @param {string} metaUrl typically `import.meta.url`
 * @param {string} [argv1] defaults to `process.argv[1]`
 * @returns {boolean} true when the module was executed directly, not imported
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}
