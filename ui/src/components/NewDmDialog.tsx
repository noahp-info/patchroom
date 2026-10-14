import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from './Icon';

export interface NewDmDialogProps {
  open: boolean;
  defaultCwd: string;
  /** Set when opened from a folder section: the DM is filed there and starts in its folder. */
  section?: { id: string; name: string } | null;
  /** Launch folders under that section's home (the home first), for the worktree switch. */
  folders?: string[];
  onClose(): void;
  onCreate(cwd: string, name: string): Promise<void>;
  onPick(defaultPath: string): Promise<string | null>;
}

function worktreeLabel(home: string, f: string, isHome: boolean): string {
  const base = f.split('/').filter(Boolean).pop() ?? f;
  if (isHome) return `${base} (home folder)`;
  return f.startsWith(`${home}/`) ? f.slice(home.length + 1) : `${base} (linked worktree)`;
}

export function NewDmDialog({
  open,
  defaultCwd,
  section = null,
  folders = [],
  onClose,
  onCreate,
  onPick,
}: NewDmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [cwd, setCwd] = useState(defaultCwd);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      setCwd(defaultCwd);
      setName('');
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open, defaultCwd]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const folder = cwd.trim();
    if (!folder || busy) return;
    setBusy(true);
    try {
      await onCreate(folder, name.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    const picked = await onPick(cwd.trim());
    if (picked) setCwd(picked);
  }

  return (
    <dialog ref={ref} className="newdm" onClose={onClose} aria-labelledby="newdm-title">
      <form onSubmit={submit}>
        <h2 id="newdm-title">New DM</h2>
        <p className="newdm__lede">
          {section
            ? `Starts in ${section.name}. Pick a worktree below to start there instead.`
            : 'Runs claude in a real terminal, in the folder you choose.'}
        </p>
        {section && folders.length > 1 && (
          <label className="field">
            <span>Worktree</span>
            <select
              value={folders.includes(cwd.trim()) ? cwd.trim() : ''}
              onChange={(e) => e.target.value && setCwd(e.target.value)}
              aria-label="Worktree"
            >
              {!folders.includes(cwd.trim()) && <option value="">Custom folder</option>}
              {folders.map((f, i) => (
                <option key={f} value={f}>
                  {worktreeLabel(folders[0], f, i === 0)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Folder</span>
          <span className="field__row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/project"
              spellCheck={false}
              autoFocus
              required
            />
            <button type="button" className="btn sec" onClick={() => void browse()}>
              <Icon name="folder" />
              Browse
            </button>
          </span>
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" />
        </label>
        <div className="newdm__foot">
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn pri" disabled={busy || cwd.trim() === ''}>
            Start DM
          </button>
        </div>
      </form>
    </dialog>
  );
}
