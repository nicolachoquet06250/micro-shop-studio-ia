import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');

test('GHCR publication requires all three desktop builds and only main', () => {
  assert.match(workflow, /publish-ghcr:[\s\S]*?needs: desktop/);
  assert.match(workflow, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /steps\.latest\.outputs\.publish == 'true'/);
});

test('latest is per platform and commit-specific tags are kept', () => {
  for (const os of ['linux-x64', 'windows-x64', 'macos-arm64']) {
    assert.ok(workflow.includes(os), `Missing ${os}`);
  }
  assert.match(workflow, /version="sha-\$\{COMMIT_SHA\}-\$\{platform\}"/);
  assert.match(workflow, /latest="\$\{platform\}-latest"/);
  assert.match(workflow, /oras tag/);
  assert.doesNotMatch(workflow, /gh release|create-release|actions\/create-release/);
});

test('downloadable CI artifacts and portable archives remain available', () => {
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /tar -czf/);
  assert.match(workflow, /actions\/download-artifact@v4/);
});
