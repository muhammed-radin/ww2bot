/**
 * Entry-point detection regression.
 *
 * `import.meta.url === \`file://${process.argv[1]}\`` silently fails when the
 * project path contains characters that import.meta.url percent-encodes — a
 * space, for example. The server then never starts. isMainModule compares the
 * URLs using the same encoding rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../../src/utils/isMain.js';

const SPACED_PATH = '/home/user/Radin Workspace/ww2bot/src/server.js';

test('a directly executed module is detected, even with a space in the path', () => {
  const metaUrl = pathToFileURL(SPACED_PATH).href;
  assert.equal(isMainModule(metaUrl, SPACED_PATH), true);
  assert.equal(isMainModule(metaUrl, '/home/user/other/src/server.js'), false);
  assert.equal(isMainModule(metaUrl, undefined), false);
  assert.equal(isMainModule(metaUrl, ''), false);
});

test('the naive file:// comparison would have failed on the encoded path', () => {
  const metaUrl = pathToFileURL(SPACED_PATH).href;
  assert.notEqual(`file://${SPACED_PATH}`, metaUrl);
  assert.match(metaUrl, /Radin%20Workspace/);
});
