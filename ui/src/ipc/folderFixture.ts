import type { FolderSession } from './types';

/** Home folder of the big synthetic fixture: 60+ sessions across worktrees and old and hidden ones. */
export const FIXTURE_HOME = '/Users/me/code/atlas';
/** A linked git worktree outside the home folder (from `git worktree list`). */
export const FIXTURE_LINKED = '/Users/me/code/atlas-release';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Where {
  cwd: string;
  rel: string;
  branch: string | null;
}

const WHERE = (home: string): Where[] => [
  { cwd: home, rel: '', branch: 'main' },
  { cwd: home, rel: '', branch: 'main' },
  { cwd: home, rel: '', branch: 'feat/billing' },
  { cwd: `${home}/packages/api`, rel: 'packages/api', branch: 'main' },
  {
    cwd: `${home}/.claude/worktrees/fix-login`,
    rel: '.claude/worktrees/fix-login',
    branch: 'worktree-fix-login',
  },
  {
    cwd: `${home}/.claude/worktrees/perf-sweep`,
    rel: '.claude/worktrees/perf-sweep',
    branch: 'worktree-perf-sweep',
  },
  { cwd: FIXTURE_LINKED, rel: '../atlas-release', branch: 'release/2.4' },
];

const TOPICS = [
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
  'Cache the pricing table',
  'Split the monolith router',
];

const PROMPTS = [
  'The webhook handler retries forever when the signature fails. Can you look at it?',
  'login.spec flakes about one run in five. Find the race.',
  'p95 on /search doubled since Tuesday. Start with the query planner.',
  'Move every .ini file into a single config.toml and update the loader.',
  'Add a token bucket in front of /v1/*. Keep it in memory for now.',
  'Summarize the merged PRs since 2.3 into a changelog entry.',
  'The worker grows 40 MB an hour. Use heap snapshots, not guesses.',
  'Swap moment for date-fns in the dashboard bundle.',
  'arm64 runners time out in the integration job. What changed?',
  'The invoice PDF clips the totals column on A4. Reproduce it first.',
  'Pricing table is read on every request. Cache it with a short TTL.',
  'routes.ts is 1900 lines. Propose a split before touching anything.',
];

const SOURCES = ['user', 'registry', 'custom-title', 'ai-title', 'prompt'] as const;

/** Deterministic pseudo-random in [0, 1). */
function rnd(i: number): number {
  const x = Math.sin(i * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/**
 * A realistic listing: every name source, subfolder and worktree sessions, a linked worktree, old
 * sessions (up to 200 days), noise rows (no real prompt) and a session live in another terminal.
 * Synthetic: nothing here comes from a real transcript.
 */
export function makeFolderFixture(home: string, count = 68, now = Date.now()): FolderSession[] {
  const where = WHERE(home);
  const out: FolderSession[] = [];
  for (let i = 0; i < count; i++) {
    const w = where[i % where.length];
    const topic = i % TOPICS.length;
    const age =
      i < 6
        ? (i + 1) * 7 * MIN
        : i < 20
          ? (i - 4) * 5 * HOUR
          : i < 44
            ? (i - 18) * 13 * HOUR + rnd(i) * 8 * HOUR
            : (15 + (i - 44) * 8) * DAY + rnd(i) * 3 * DAY;
    const noise = i % 9 === 8;
    const src = noise ? 'prompt' : SOURCES[i % SOURCES.length];
    const base = TOPICS[topic];
    const name = noise
      ? '(no prompt)'
      : src === 'prompt'
        ? PROMPTS[topic].slice(0, 60)
        : `${base}${i >= TOPICS.length ? ` ${Math.floor(i / TOPICS.length) + 1}` : ''}`;
    out.push({
      sessionId: `fx-${String(i + 1).padStart(3, '0')}`,
      name,
      nameSource: src,
      launchCwd: w.cwd,
      relPath: w.rel,
      branch: w.branch,
      lastActivity: now - age,
      firstPrompt: noise ? '' : PROMPTS[topic],
      lastPrompt: noise ? '' : `Follow-up ${i + 1}: ${PROMPTS[(topic + 5) % PROMPTS.length]}`,
      userTurns: noise ? 0 : 2 + (i % 11),
      liveElsewhere: i === 2,
      hidden: noise,
      dmId: null,
    });
  }
  return out;
}

/** A small listing for any other folder a test picks. */
export function makeSmallFixture(home: string, now = Date.now()): FolderSession[] {
  return makeFolderFixture(home, 4, now).map((f, i) => ({
    ...f,
    launchCwd: home,
    relPath: '',
    liveElsewhere: false,
    hidden: false,
    userTurns: 3,
    name: ['Plan the rollout', 'Fix the parser', 'Tidy the docs', 'Spike on caching'][i],
  }));
}
