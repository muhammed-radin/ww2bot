#!/usr/bin/env node
/**
 * Build the ww2web dashboard and publish it for the Express service.
 *
 * The gateway serves the dashboard from `public/frontend/`, and Vite emits
 * hashed assets under `ww2web/dist/`. This script is the only supported way to
 * move one to the other, because a half-copied build is worse than no build:
 *
 *   1. docs            — publish `docs/*.md` into the dashboard's content dir
 *   2. build           — `npm run build` inside `ww2web/`
 *   3. verify          — `dist/index.html` must exist and point at
 *                        `/frontend/assets/...` (the asset base path)
 *   4. stage           — copy the *contents* of `dist/` into a fresh staging
 *                        directory next to the destination
 *   5. publish         — replace `public/frontend/` with the staged directory
 *
 * Nothing is written to `public/frontend/` unless every earlier step succeeded,
 * and unrelated files in `public/` are never touched. No dependencies are used
 * beyond the Node standard library.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { syncDocs } from './sync-docs.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const appDir = path.join(repoRoot, 'ww2web');
const distDir = path.join(appDir, 'dist');
const distIndex = path.join(distDir, 'index.html');
const publicDir = path.join(repoRoot, 'public');
const publishDir = path.join(publicDir, 'frontend');
const stagingDir = path.join(publicDir, `.frontend-staging-${process.pid}`);

const ASSET_BASE = '/frontend/';

function log(message) {
  process.stdout.write(`[build:frontend] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[build:frontend] error: ${message}\n`);
  process.exit(1);
}

/** Run a command in `cwd`, inheriting stdio, and reject on a non-zero exit. */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`));
    });
  });
}

async function assertDirectory(target, hint) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) fail(`${target} exists but is not a directory.${hint ? ` ${hint}` : ''}`);
  } catch {
    fail(`missing ${target}${hint ? `. ${hint}` : ''}`);
  }
}

async function main() {
  await assertDirectory(appDir, 'The dashboard source must be present.');

  if (!existsSync(path.join(appDir, 'node_modules'))) {
    fail('frontend dependencies are not installed. Run: npm --prefix ww2web install');
  }

  // Documentation is copied from `docs/` before every build, so the in-app
  // Docs page can never drift from the repository's own documentation.
  try {
    await syncDocs({ logger: { log: (message) => log(message.replace(/^\[sync:docs\]\s*/, '')) } });
  } catch (error) {
    fail(`could not publish the documentation into the dashboard. ${error.message}`);
  }

  log('building the dashboard (ww2web: npm run build)');
  try {
    await run('npm', ['run', 'build'], appDir);
  } catch (error) {
    fail(`dashboard build failed — nothing was published. ${error.message}`);
  }

  if (!existsSync(distIndex)) {
    fail(`the build did not produce ${path.relative(repoRoot, distIndex)} — nothing was published.`);
  }

  const html = await readFile(distIndex, 'utf8');
  if (!html.includes(`${ASSET_BASE}assets/`)) {
    fail(
      `the built index.html does not reference "${ASSET_BASE}assets/". ` +
        'Check that vite.config.js still sets base to "/frontend/". Nothing was published.',
    );
  }

  // Stage a complete copy first, so a failure never leaves a partial publish.
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });
  log(`staging build output into ${path.relative(repoRoot, stagingDir)}`);
  await cp(distDir, stagingDir, { recursive: true });

  if (!existsSync(path.join(stagingDir, 'index.html'))) {
    await rm(stagingDir, { recursive: true, force: true });
    fail('staging did not produce index.html — nothing was published.');
  }

  // Swap the destination into place. `rename` is atomic on the same filesystem.
  await rm(publishDir, { recursive: true, force: true });
  await rename(stagingDir, publishDir);

  const entries = await readdir(path.join(publishDir, 'assets')).catch(() => []);
  log(`published ${entries.length} asset file(s) to ${path.relative(repoRoot, publishDir)}`);
  log('the dashboard is served by the running service at /ui/');
}

main().catch(async (error) => {
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  fail(error?.message ?? String(error));
});
