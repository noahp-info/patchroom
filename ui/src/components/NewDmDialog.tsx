import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from './Icon';

export interface NewDmDialogProps {
  open: boolean;
  defaultCwd: string;
  onClose(): void;
  onCreate(cwd: string, name: string): Promise<void>;
  onPick(defaultPath: string): Promise<string | null>;
}

export function NewDmDialog({ open, defaultCwd, onClose, onCreate, onPick }: NewDmDialogProps) {
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
        <p className="newdm__lede">Runs claude in a real terminal, in the folder you choose.</p>
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
