import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Exercise the actual image command with a fake node: a failed migration must start no services.
test('image startup fails closed when database migration fails', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const command = JSON.parse(dockerfile.split('\n').find(line => line.startsWith('CMD '))!.slice(4)) as string[];
  const dir = mkdtempSync(path.join(tmpdir(), 'kpl-startup-'));
  try {
    const calls = path.join(dir, 'calls');
    writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho "$1" >> "$CALLS"\nif [ "$1" = "scripts/migrate.ts" ]; then exit 37; fi\n', { mode: 0o700 });
    const result = spawnSync(command[0]!, command.slice(1), { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls }, timeout: 5000 });
    assert.equal(result.status, 37, 'migration failure must stop container startup');
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['scripts/migrate.ts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
