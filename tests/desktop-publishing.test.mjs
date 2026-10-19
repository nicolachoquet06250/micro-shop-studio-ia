import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');

test('release publication waits for successful builds on main, never runs on PR', () => {
  assert.match(workflow, /publish-release:[\s\S]*?needs: desktop/);
  assert.match(workflow, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /desktop-latest-release/);
  assert.match(workflow, /current.*GITHUB_SHA/);
});

test('one stable, published latest release with replacement archives', () => {
  assert.match(workflow, /gh release view latest/);
  assert.match(workflow, /gh release create latest/);
  assert.match(workflow, /gh release edit latest/);
  assert.match(workflow, /--title "Builds"/);
  assert.match(workflow, /--latest/);
  assert.match(workflow, /gh release upload latest.*--clobber/);
  assert.match(workflow, /git\/refs\/tags\/latest/);
  assert.doesNotMatch(workflow, /publish-ghcr|oras push|packages: write/);
});

test('distributables use consistent direct download filenames', () => {
  for (const filename of [
    'MicroShopStudio-Linux-x64.tar.gz',
    'MicroShopStudio-Windows-x64.zip',
    'MicroShopStudio-macOS-arm64.zip',
  ]) assert.ok(workflow.includes(filename), filename);
  assert.match(workflow, /tar -tzf/);
  assert.match(workflow, /unzip -t/);
});

test('CI artifacts remain available independently of GitHub Releases', () => {
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /retention-days: 14/);
});
