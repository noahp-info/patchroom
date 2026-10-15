import { useCatalog } from '../../../sound/catalog.ts';

/** Who made the sounds and under what license. Also used by an About panel. */
export function SoundCredits() {
  const { packs } = useCatalog();
  return (
    <div className="credits" data-testid="sound-credits">
      <p className="pf-hint">
        The file packs use sounds by Kenney (kenney.nl), released under the CC0 1.0 public domain
        dedication. Kenney asks for no credit. Patchroom gives it anyway. The generated packs are
        synthesized inside Patchroom and are Apache-2.0.
      </p>
      <ul className="plist">
        {packs.map((p) => (
          <li key={p.id}>
            <span className="plist__name">{p.name}</span>
            <span className="pf-hint">
              {p.author}, {p.license}
              {p.source ? `. ${p.source}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
