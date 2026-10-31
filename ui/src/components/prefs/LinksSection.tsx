import { getPrefsStore, usePrefs } from './store.ts';
import type { LinkTarget } from './ipc.ts';

const CHOICES: { id: LinkTarget; label: string }[] = [
  { id: 'patchroom', label: 'In Patchroom' },
  { id: 'browser', label: 'In my browser' },
];

/** Where links open: the in-app viewer or the system default browser. */
export function LinksSection() {
  const prefs = usePrefs();
  const store = getPrefsStore();
  return (
    <div className="pf-section" data-testid="prefs-links">
      <h2>Links</h2>
      <p className="pf-hint">
        Where a link opens when you click it. Hold &#8984; to open it in the other place. The viewer
        always has an Open in browser button.
      </p>
      <div className="pf-seg" role="radiogroup" aria-label="Open links" data-setting="links.open">
        {CHOICES.map((c) => (
          <label key={c.id} className="pf-seg__opt">
            <input
              type="radio"
              name="links-open"
              checked={(prefs.links?.open ?? 'patchroom') === c.id}
              onChange={() => void store.update({ links: { open: c.id } })}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>

      <h3 data-setting="links.artifacts">Artifacts</h3>
      <label className="chk" data-setting="links.autopin">
        <input
          type="checkbox"
          data-testid="artifacts-autopin"
          checked={prefs.artifacts?.autoPin ?? true}
          onChange={(e) => void store.update({ artifacts: { autoPin: e.target.checked } })}
        />
        <span>Pin artifacts automatically</span>
      </label>
      <p className="pf-hint">
        Each artifact Claude publishes is pinned once, so it sits in the session&#8217;s Pins next
        to your important messages. Unpin any you do not need; they stay unpinned.
      </p>
    </div>
  );
}
