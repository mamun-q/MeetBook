// Lint = syntax-check every JS source file. Keeps the toolchain
// dependency-free while still failing CI on broken code.
// `node --check` respects the nearest package.json "type": the repo root is
// ESM ("type": "module") and functions/ defaults to CommonJS — exactly the
// semantics each part of the codebase runs with.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['src', 'tests', 'functions'];
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
}
for (const r of roots) walk(r);
files.push('vite.config.js');

let failed = 0;
for (const f of files) {
  const res = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    console.error(`✗ ${f}\n${res.stderr || res.stdout}`);
  } else {
    console.log(`✓ ${f}`);
  }
}
if (failed) { console.error(`\n${failed} file(s) failed syntax check.`); process.exit(1); }
console.log(`\nAll ${files.length} files passed syntax check.`);
