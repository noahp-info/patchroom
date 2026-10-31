#!/usr/bin/env node
// Refresh the model catalog the app ships (ui/src/lib/models/catalog.json).
//
// Reads the providers' published model lists from the public models.dev catalog (no key, no
// secret), keeps every model in the checked-in fallback (catalog/sources.json) and writes the
// merged catalog. Run by .github/workflows/model-catalog.yml once a week; it opens a PR when
// the file changed. Exit 0 with no write when nothing but the date would change.
//
// Usage: node scripts/update-model-catalog.mjs [--offline] [--source <api.json>]
//   --offline          use only catalog/sources.json
//   --source <file>    read a saved models.dev api.json instead of fetching (tests, dry runs)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'ui/src/lib/models/catalog.json');
const SOURCES = join(root, 'catalog/sources.json');
const FEED = 'https://models.dev/api.json';

/** Provider in models.dev to the tool whose CLI runs its models first. */
const PROVIDER_TOOL = { anthropic: 'claude-code', openai: 'codex', google: 'gemini' };
/** Models that are not for a coding CLI chat. */
const SKIP = /(image|realtime|tts|audio|embed|live|translate|transcribe|search|moderation|banana)/i;
/** Models released before this are left out. */
const MIN_RELEASE = '2025-06-01';
const SAFE_ID = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const srcAt = args.indexOf('--source');

/** "claude-opus-5-5" -> "5.5", "gpt-6.1-sol" -> "6.1", "gemini-3.8-flash" -> "3.8". */
export function versionOf(id) {
  const m = /(\d+)(?:[.-](\d{1,2})(?![\dA-Za-z]))?/.exec(id.replace(/-\d{8}$/, ''));
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : '0';
}

/** "claude-opus" -> "opus"; other families stay as published. */
export function familyOf(provider, raw, id) {
  const f = typeof raw === 'string' && raw ? raw : id.replace(/[-.\d]+.*$/, '');
  return provider === 'anthropic' ? f.replace(/^claude-/, '') : f;
}

function fromFeed(feed) {
  const out = [];
  for (const [provider, tool] of Object.entries(PROVIDER_TOOL)) {
    const models = feed?.[provider]?.models ?? {};
    for (const m of Object.values(models)) {
      const id = String(m?.id ?? '');
      const name = String(m?.name ?? '').replace(/^Claude /, '');
      if (!SAFE_ID.test(id) || id.startsWith('-')) continue;
      // Dated snapshots and moving aliases: the dated id or `latest:<family>` covers them.
      if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$|-latest$|-\d{2}-\d{4}$/.test(id)) continue;
      if (/\(latest\)/i.test(m?.name ?? '')) continue;
      // Older than the CLIs that would run them.
      if (typeof m?.release_date === 'string' && m.release_date < MIN_RELEASE) continue;
      if (versionOf(id) === '0') continue;
      if (SKIP.test(id) || SKIP.test(name)) continue;
      if (m?.tool_call === false) continue;
      if (Array.isArray(m?.modalities?.output) && !m.modalities.output.includes('text')) continue;
      out.push({
        id,
        tool,
        name: name || id,
        family: familyOf(provider, m?.family, id),
        version: versionOf(id),
        ...(typeof m?.release_date === 'string' ? { released: m.release_date } : {}),
        where: m?.open_weights && provider === 'ollama' ? 'local' : 'cloud',
      });
    }
  }
  return out;
}

async function loadFeed() {
  if (offline) return null;
  if (srcAt >= 0) return JSON.parse(readFileSync(args[srcAt + 1], 'utf8'));
  const res = await fetch(FEED, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${FEED}: HTTP ${res.status}`);
  return res.json();
}

function key(m) {
  return `${m.tool}\u0000${m.id}`;
}

function sortModels(list) {
  const num = (v) => v.split('.').map((x) => Number(x) || 0);
  return [...list].sort((a, b) => {
    if (a.tool !== b.tool) return a.tool.localeCompare(b.tool);
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    const [x, y] = [num(a.version), num(b.version)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    }
    return a.id.localeCompare(b.id);
  });
}

export function merge(sources, fetched) {
  const byKey = new Map(sources.models.map((m) => [key(m), { ...m }]));
  for (const m of fetched) {
    const have = byKey.get(key(m));
    if (have) {
      if (m.released && !have.released) have.released = m.released;
    } else {
      byKey.set(key(m), m);
    }
  }
  return sortModels([...byKey.values()]);
}

async function main() {
  const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));
  let fetched = [];
  try {
    fetched = fromFeed(await loadFeed());
  } catch (err) {
    // The checked-in list is the fallback: the catalog never loses models.
    console.error(`update-model-catalog: feed unavailable, using sources.json only (${err})`);
  }
  const models = merge(sources, fetched);
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    // First run.
  }
  const same =
    prev &&
    JSON.stringify(prev.models) === JSON.stringify(models) &&
    JSON.stringify(prev.tools) === JSON.stringify(sources.tools);
  if (same) {
    console.log('update-model-catalog: no change');
    return;
  }
  const generated = new Date().toISOString().slice(0, 10);
  const out = { schema: 1, generated, tools: sources.tools, models };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`update-model-catalog: wrote ${models.length} models`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
