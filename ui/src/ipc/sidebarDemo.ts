import type { MockControl } from './mock';
import type { FolderSession } from './types';

const HOME = '/Users/me/code/gamerNetworking';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const NAMES = [
  'Fix the iOS profile capability check',
  'Dev deploy waits on the state lock',
  'Hots art pass: plain Lanczos only',
  'Reel assembly: real voice track',
  'Buffer batch of 20, never per post',
  'Gate the judge on backlog builds',
  'Android emulator fleet warmup',
  'Associated domains on both App IDs',
  'Surgical CI pushes, no rerun storms',
  'Merge gating when auto-merge is off',
  'Content pipeline: replica renderer',
  'Trim the Playwright matrix',
  'Terraform plan drift on stage',
  'Why does the arm64 job time out',
  'Cache the pricing table',
];

/**
 * A gamerNetworking-like folder: `count` sessions, mostly on the folder's own branch (`dev`), a few
 * on feature branches and in worktrees. Synthetic.
 */
export function makeGamerFixture(count = 30, now = Date.now()): FolderSession[] {
  return Array.from({ length: count }, (_, i) => {
    const feat = i % 7 === 3;
    const wt = i % 11 === 5;
    const age = i < 4 ? (i + 1) * 9 * MIN : i < 14 ? (i - 2) * 3 * HOUR : (i - 11) * 2 * DAY;
    const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''}`;
    return {
      sessionId: `gn-${String(i + 1).padStart(3, '0')}`,
      name,
      nameSource: 'ai-title',
      launchCwd: wt ? `${HOME}/.claude/worktrees/wt-${i}` : HOME,
      relPath: wt ? `.claude/worktrees/wt-${i}` : '',
      branch: wt ? `worktree-wt-${i}` : feat ? `feat/lane-${i}` : 'dev',
      folderBranch: 'dev',
      lastActivity: now - age,
      firstPrompt: `Start of: ${name}`,
      lastPrompt: `Follow-up on ${name.toLowerCase()}. Keep it small and run the checks first.`,
      userTurns: 3 + (i % 9),
      liveElsewhere: false,
      hidden: false,
      dmId: null,
    };
  });
}

/**
 * `?mock&sidebar-demo`: an organized sidebar for screenshots, the axe scan and the Impeccable
 * detector. A 30-session folder section with emoji, a needs-you DM, a labeled divider that groups
 * two sections, an unlabeled divider and the default groups.
 */
export function seedSidebarDemo(control: MockControl): void {
  const gn = control.addSection({
    id: 'gn',
    name: 'gamerNetworking',
    folder: HOME,
    emoji: '🎮',
    position: 0,
  });
  const rows = makeGamerFixture();
  const dm = (id: string, name: string, rowIdx: number, status: 'busy' | 'idle' | 'waiting') => {
    control.addSession({ id, name, cwd: HOME, sectionId: gn.id, status });
    rows[rowIdx] = { ...rows[rowIdx], name, dmId: id };
  };
  dm('dm-ci', 'ci-gate', 0, 'waiting');
  dm('dm-ios', 'ios-profiles', 1, 'busy');
  dm('dm-art', 'art-pass', 2, 'idle');
  control.setFolderRows(gn.id, rows);
  // Badges travel as events: send them once the store is listening.
  window.setTimeout(() => control.setBadges('dm-art', 3, false), 300);

  control.addSection({ id: 'div-side', name: 'Side projects', kind: 'divider', position: 1 });
  control.addSection({ id: 'kf', name: 'knowfirst', emoji: '📈', position: 2 });
  control.addSection({ id: 'lab', name: 'Experiments', emoji: '🧪', position: 3 });
  control.addSection({ id: 'div-plain', name: '', kind: 'divider', position: 4 });
  const mk = (
    id: string,
    name: string,
    sectionId: string | null,
    status: 'busy' | 'idle' | 'waiting',
  ) => control.addSession({ id, name, cwd: `/Users/me/code/${name}`, sectionId, status });
  mk('dm-kf1', 'receipts-tracker', 'kf', 'idle');
  mk('dm-kf2', 'alert-feed', 'kf', 'waiting');
  mk('dm-lab', 'ui-spike', 'lab', 'busy');
  mk('dm-a', 'notes', null, 'idle');
  mk('dm-b', 'scratch', null, 'idle');
  control.addSession({
    id: 'dm-star',
    name: 'release-train',
    cwd: '/Users/me/code/patchroom',
    sectionId: null,
    status: 'idle',
    starred: true,
  });
}
