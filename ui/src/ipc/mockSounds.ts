import type {
  ClaudeProfile,
  ImportedFile,
  PackInfo,
  SoundEvent,
  SoundFileData,
} from '../components/prefs/ipc.ts';
import generated from '../../../plugins/sounds/generated-packs.json';

/**
 * The sound-pack commands of docs/gauntlet/SOUND-PACKS-BAR.md for the browser and Playwright.
 * The pack list is the real one: the four generated packs and the seven CC0 file packs in
 * plugins/sounds. In dev the real m4a files are served; elsewhere a short tone stands in.
 */

const EVENTS: SoundEvent[] = [
  'needs',
  'done',
  'message',
  'error',
  'bell',
  'decision',
  'due',
  'session',
];

interface FilePackJson {
  id: string;
  name: string;
  description: string;
  license: string;
  author: string;
  source: string;
  sounds: Record<string, string>;
}

const packJson = import.meta.glob<FilePackJson>('../../../plugins/sounds/*/pack.json', {
  eager: true,
  import: 'default',
});

// Only dev serves the real audio, so a production bundle never carries the m4a files.
const audioUrls: Record<string, () => Promise<string>> = import.meta.env.DEV
  ? (import.meta.glob('../../../plugins/sounds/*/sounds/*.m4a', {
      query: '?url',
      import: 'default',
    }) as Record<string, () => Promise<string>>)
  : {};

const ALL_EVENTS = Object.fromEntries(EVENTS.map((e) => [e, true])) as Record<SoundEvent, true>;

function bundledPacks(): PackInfo[] {
  const gen: PackInfo[] = generated.packs.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.blurb,
    kind: 'generated',
    license: 'Apache-2.0',
    author: 'Patchroom',
    source: p.source,
    events: { ...ALL_EVENTS },
  }));
  const files: PackInfo[] = Object.values(packJson)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: 'files' as const,
      license: p.license,
      author: p.author,
      source: p.source,
      events: Object.fromEntries(
        EVENTS.filter((e) => p.sounds[e]).map((e) => [e, true]),
      ) as PackInfo['events'],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...gen, ...files];
}

/** A short mono 16-bit wav of a sine tone, as a data URL. Stands in where there is no m4a. */
export function toneDataUrl(freq: number, seconds = 0.25): string {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 80) * (1 - i / n);
    v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / rate) * env * 12000, true);
  }
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** A file the mock "disk" holds, for the file picker and `sound_import_file`. */
export interface MockDiskFile {
  name: string;
  bytes: number;
  durationMs: number;
  /** Normalizing gain the backend would measure. Default 1. */
  norm?: number;
  /** Loudest sample after the gain. Default 0.5. */
  peak?: number;
}

export const SOUND_LIMITS = {
  ms: 5000,
  bytes: 2 * 1024 * 1024,
  exts: ['wav', 'aiff', 'mp3', 'm4a'],
};

export interface MockSoundOptions {
  profiles?: ClaudeProfile[];
}

export interface MockSoundControl {
  /** What the next `sound_pick_file` resolves to (null: cancelled). */
  nextPick: string | null;
  /** Files the picker can hand to `sound_import_file`, by path. */
  disk: Record<string, MockDiskFile>;
  /** Ids of the user's own files the "backend" holds. */
  custom: Map<string, ImportedFile>;
  profiles: ClaudeProfile[];
  /** Every call, in order: `name:arg`. */
  calls: string[];
}

export interface MockSoundBackend {
  control: MockSoundControl;
  soundPacks(): Promise<PackInfo[]>;
  soundFile(packId: string, event: string): Promise<SoundFileData>;
  soundCustomList(): Promise<ImportedFile[]>;
  soundCustomFile(id: string): Promise<SoundFileData>;
  soundPickFile(): Promise<string | null>;
  soundImportFile(path: string): Promise<ImportedFile>;
  soundCustomRemove(id: string): Promise<void>;
  soundClaudeProfiles(): Promise<ClaudeProfile[]>;
  soundImportClaudeProfile(id: string): Promise<{ packId: string }>;
}

const SEED_DISK: Record<string, MockDiskFile> = {
  '/Users/me/Sounds/chime.wav': { name: 'chime.wav', bytes: 96_000, durationMs: 1200 },
  // A hot file: it peaks at full scale, so the clamp has work to do.
  '/Users/me/Sounds/airhorn.wav': {
    name: 'airhorn.wav',
    bytes: 120_000,
    durationMs: 1500,
    norm: 0.9,
    peak: 1,
  },
  '/Users/me/Sounds/knock.m4a': { name: 'knock.m4a', bytes: 41_000, durationMs: 800 },
  '/Users/me/Sounds/theme-song.mp3': {
    name: 'theme-song.mp3',
    bytes: 1_400_000,
    durationMs: 12_000,
  },
  '/Users/me/Sounds/ambience.aiff': { name: 'ambience.aiff', bytes: 3_200_000, durationMs: 4000 },
  '/Users/me/Sounds/notes.txt': { name: 'notes.txt', bytes: 300, durationMs: 0 },
};

const SEED_PROFILES: ClaudeProfile[] = [
  { id: 'default', name: 'default', events: ['needs', 'done', 'error'] },
  { id: 'quiet-desk', name: 'quiet-desk', events: ['needs', 'done'] },
];

export function createMockSoundBackend(opts: MockSoundOptions = {}): MockSoundBackend {
  const control: MockSoundControl = {
    nextPick: null,
    disk: structuredClone(SEED_DISK),
    custom: new Map(),
    profiles: structuredClone(opts.profiles ?? SEED_PROFILES),
    calls: [],
  };
  const imported: PackInfo[] = [];
  const mb = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

  return {
    control,
    async soundPacks() {
      control.calls.push('sound_packs');
      return [...bundledPacks(), ...structuredClone(imported)];
    },
    async soundFile(packId, event) {
      control.calls.push(`sound_file:${packId}:${event}`);
      const key = Object.keys(audioUrls).find((k) =>
        k.endsWith(`/plugins/sounds/${packId}/sounds/${event}.m4a`),
      );
      if (key) {
        const res = await fetch(await audioUrls[key]());
        return { dataUrl: await blobToDataUrl(await res.blob()), norm: 1, peak: 0.75 };
      }
      // Imported packs have no audio in the mock: a tone per event stands in.
      const at = Math.max(0, EVENTS.indexOf(event as SoundEvent));
      return { dataUrl: toneDataUrl(440 * 2 ** (at / 12)), norm: 1, peak: 0.75 };
    },
    async soundCustomList() {
      control.calls.push('sound_custom_list');
      return [...control.custom.values()].reverse();
    },
    async soundCustomFile(id) {
      control.calls.push(`sound_custom_file:${id}`);
      if (!control.custom.has(id)) throw new Error('No such sound.');
      const rec = control.custom.get(id)!;
      return { dataUrl: toneDataUrl(523.25), norm: rec.norm ?? 1, peak: rec.peak ?? 0.5 };
    },
    async soundPickFile() {
      control.calls.push('sound_pick_file');
      const p = control.nextPick;
      control.nextPick = null;
      return p;
    },
    async soundImportFile(path) {
      control.calls.push(`sound_import_file:${path}`);
      const f = control.disk[path];
      if (!f) throw new Error('That file could not be read.');
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (!SOUND_LIMITS.exts.includes(ext)) {
        throw new Error(`Unsupported format .${ext}. Use wav, aiff, mp3 or m4a.`);
      }
      if (f.durationMs > SOUND_LIMITS.ms) {
        throw new Error(
          `${f.name} is ${(f.durationMs / 1000).toFixed(0)} s long. The limit is ${SOUND_LIMITS.ms / 1000} s.`,
        );
      }
      if (f.bytes > SOUND_LIMITS.bytes) {
        throw new Error(
          `${f.name} is ${(f.bytes / (1024 * 1024)).toFixed(1)} MB. The limit is ${mb(SOUND_LIMITS.bytes)}.`,
        );
      }
      const id = `01J${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(10, '0')}`;
      const rec = {
        id,
        name: f.name.replace(/\.[^.]+$/, ''),
        durationMs: f.durationMs,
        norm: f.norm ?? 1,
        peak: f.peak ?? 0.5,
      };
      control.custom.set(id, rec);
      return rec;
    },
    async soundCustomRemove(id) {
      control.calls.push(`sound_custom_remove:${id}`);
      control.custom.delete(id);
    },
    async soundClaudeProfiles() {
      control.calls.push('sound_claude_profiles');
      return structuredClone(control.profiles);
    },
    async soundImportClaudeProfile(id) {
      control.calls.push(`sound_import_claude_profile:${id}`);
      const p = control.profiles.find((x) => x.id === id);
      if (!p) throw new Error('No such Claude sound profile.');
      const packId = `claude-${p.id}`;
      if (!imported.some((x) => x.id === packId)) {
        imported.push({
          id: packId,
          name: `Claude: ${p.name}`,
          description: 'Copied from your Claude Code sound profile.',
          kind: 'imported',
          license: 'Yours',
          author: 'You',
          source: 'Your Claude Code sound profile',
          events: Object.fromEntries(p.events.map((e) => [e, true])) as PackInfo['events'],
        });
      }
      return { packId };
    },
  };
}
