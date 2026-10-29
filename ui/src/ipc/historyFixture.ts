import type { HistorySession } from './types';

/**
 * A synthetic History listing: `n` sessions across a dozen folders, several models and branches,
 * spread from today back over a year. Deterministic for a given `n` and `now`. Nothing here comes
 * from a real transcript.
 */

const DAY = 86_400_000;

const FOLDERS = [
  '/Users/me/code/atlas',
  '/Users/me/code/patchroom',
  '/Users/me/code/billing-service',
  '/Users/me/code/design-system',
  '/Users/me/code/infra',
  '/Users/me/code/mobile-app',
  '/Users/me/code/docs-site',
  '/Users/me/code/data-pipeline',
  '/Users/me/code/search-api',
  '/Users/me/code/notebooks',
  '/Users/me/code/scratch',
  '/Users/me/code/a-very-long-folder-name-that-has-to-truncate-cleanly-in-narrow-windows',
];

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-haiku-5-5'];

const BRANCHES = ['main', 'feat/billing', 'fix/login-race', 'release/2.4', null];

const TITLES = [
  'Refactor billing webhooks',
  'Fix flaky login test',
  'Profile the search endpoint',
  'Migrate config to TOML',
  'Add rate limiting to the API',
  'Draft the 2.4 changelog',
  'Trace the memory leak in the worker',
  'Replace moment with date-fns',
  'Why does CI time out on arm64',
  'Review the invoice PDF layout',
];

const PROMPTS = [
  'The webhook handler retries forever when the signature fails. Can you look at it?',
  'login.spec flakes about one run in five. Find the race.',
  'p95 on /search doubled since Tuesday. Start with the query planner.',
  'Move every .ini file into a single config.toml and update the loader.',
  'Add a token bucket in front of /v1/*. Keep it in memory for now.',
  'Summarize the merged PRs since 2.3 into a changelog entry.',
  'RSS on the worker grows 40 MB an hour. Find what holds on.',
  'Swap moment for date-fns across the web app, keep the formats identical.',
  'The arm64 runner hits the 60 minute limit on the integration suite.',
  'The invoice PDF wraps the totals table on A4. Make it fit.',
];

/** Session id `i` as a UUID-shaped token. */
export const historyId = (i: number): string =>
  `${i.toString(16).padStart(8, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

export function historyFixture(n: number, now = Date.now()): HistorySession[] {
  const out: HistorySession[] = [];
  for (let i = 0; i < n; i++) {
    const folder = FOLDERS[i % FOLDERS.length];
    // The first few are today, then it thins out over a year.
    const age = i < 4 ? i * 3_600_000 : Math.floor(((i * 37) % 365) * DAY + (i % 24) * 3_600_000);
    const worktree = i % 9 === 4;
    const topic = i % TITLES.length;
    const titled = i % 3 !== 2;
    out.push({
      sessionId: historyId(i + 1),
      title: titled ? TITLES[topic] : PROMPTS[topic].slice(0, 80),
      titleSource: titled ? 'ai-title' : 'prompt',
      firstPrompt: PROMPTS[topic],
      launchCwd: worktree ? `${folder}/.claude/worktrees/wt-${i}` : folder,
      folder,
      branch: BRANCHES[i % BRANCHES.length],
      model: MODELS[i % MODELS.length],
      lastActivity: now - age,
      userTurns: 1 + (i % 17),
      dmId: null,
      liveState: i === 2 ? 'live' : 'free',
    });
  }
  return out.sort((a, b) => Number(b.lastActivity) - Number(a.lastActivity));
}
