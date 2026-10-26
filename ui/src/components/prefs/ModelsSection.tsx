import { useEffect, useState } from 'react';
import type {
  BundleEntry,
  ModelBundle,
  ModelCatalog,
  ModelPlace,
  ModelPrefs,
  ToolId,
} from '../../ipc/types.ts';
import { ADAPTERS, TOOL_IDS, safeModel } from '../../lib/models/adapters.ts';
import { modelsOf, newId } from '../../lib/models/bundles.ts';
import {
  LATEST_PREFIX,
  SHIPPED_CATALOG,
  families,
  mergeCatalogs,
  modelName,
} from '../../lib/models/catalog.ts';
import { getPrefsStore, usePrefs } from './store.ts';
import type { PrefsDm, PrefsSection } from './types.ts';

/** The catalog this pane offers: the shipped one plus a signed one fetched earlier. */
function useCatalog(): ModelCatalog {
  const [cat, setCat] = useState<ModelCatalog>(SHIPPED_CATALOG);
  useEffect(() => {
    let live = true;
    void getPrefsStore()
      .api.catalogGet?.()
      .then((c) => live && c && setCat(mergeCatalogs(SHIPPED_CATALOG, c)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return cat;
}

/** A fresh bundle: the newest Opus as its default. */
function blankBundle(n: number): ModelBundle {
  const first: BundleEntry = { id: newId('m'), tool: 'claude-code', model: `${LATEST_PREFIX}opus` };
  return {
    id: newId('b'),
    name: n === 0 ? 'My models' : `Bundle ${n + 1}`,
    emoji: null,
    entries: [first],
    defaultEntry: first.id,
  };
}

/** Settings > Models: bundles, where each one applies, and how model names read in the chip. */
export function ModelsSection({
  dms = [],
  sections = [],
}: {
  dms?: PrefsDm[];
  sections?: PrefsSection[];
}) {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const cat = useCatalog();
  const models = modelsOf(prefs);
  const save = (next: ModelPrefs) => void store.update({ models: next });
  const asked = prefs.updates?.askedModels || prefs.updates?.checkModels;

  const setBundle = (b: ModelBundle) =>
    save({ ...models, bundles: models.bundles.map((x) => (x.id === b.id ? b : x)) });
  const addBundle = () => {
    const b = blankBundle(models.bundles.length);
    save({
      ...models,
      bundles: [...models.bundles, b],
      defaultBundle: models.defaultBundle ?? b.id,
    });
  };
  const removeBundle = (id: string) => {
    const bundles = models.bundles.filter((b) => b.id !== id);
    const drop = (m: Record<string, string>) =>
      Object.fromEntries(Object.entries(m).filter(([, v]) => v !== id));
    save({
      ...models,
      bundles,
      defaultBundle: models.defaultBundle === id ? (bundles[0]?.id ?? null) : models.defaultBundle,
      perFolder: drop(models.perFolder),
      perSection: drop(models.perSection),
      perSession: drop(models.perSession),
    });
  };

  // Every model the user can label: the bundles' models and the ones the chip has shown.
  const labelIds = (() => {
    const ids = new Set<string>();
    for (const b of models.bundles)
      for (const e of b.entries) if (!e.model.startsWith(LATEST_PREFIX)) ids.add(e.model);
    for (const id of models.seen) ids.add(id);
    for (const id of Object.keys(models.labels)) ids.add(id);
    return [...ids];
  })();

  return (
    <div className="pf-section" data-testid="prefs-models">
      <h2>Models</h2>
      <p className="pf-hint">
        A bundle is the set of models you switch between. New sessions start on its default. The
        model chip in the status bar switches within the bundle, only while the session is idle.
      </p>

      {!asked && (
        <div
          className="pf-ask"
          role="group"
          aria-label="Check for newer models"
          data-testid="model-ask"
        >
          <p className="pf-ask__q">Want to check for newer models?</p>
          <p className="pf-hint">
            Patchroom would download a signed model list now and then, so new models show up before
            the next app update. It sends nothing about you. Change it in Settings &gt; Updates.
          </p>
          <div className="pf-row">
            <button
              type="button"
              className="btn pri"
              data-testid="model-ask-on"
              onClick={() =>
                void store.update({
                  updates: {
                    checkApp: prefs.updates?.checkApp ?? false,
                    checkModels: true,
                    askedModels: true,
                  },
                })
              }
            >
              Turn on
            </button>
            <button
              type="button"
              className="btn sec"
              data-testid="model-ask-later"
              onClick={() =>
                void store.update({
                  updates: {
                    checkApp: prefs.updates?.checkApp ?? false,
                    checkModels: false,
                    askedModels: true,
                  },
                })
              }
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <h3>Bundles</h3>
      {models.bundles.length === 0 ? (
        <p className="pf-empty" data-testid="bundles-empty">
          No bundles yet. Sessions start on Claude Code&#8217;s own default model until you add one.
        </p>
      ) : (
        <div className="mb-list">
          {models.bundles.map((b) => (
            <BundleCard
              key={b.id}
              bundle={b}
              catalog={cat}
              isDefault={models.defaultBundle === b.id}
              onChange={setBundle}
              onRemove={() => removeBundle(b.id)}
              onMakeDefault={() => save({ ...models, defaultBundle: b.id })}
            />
          ))}
        </div>
      )}
      <div className="pf-row">
        <button type="button" className="btn sec" data-testid="bundle-add" onClick={addBundle}>
          Add a bundle
        </button>
      </div>

      {models.bundles.length > 0 && (
        <>
          <h3>Where bundles apply</h3>
          <p className="pf-hint">
            A session uses its own bundle first, then its section&#8217;s or folder&#8217;s, then
            the default. Pick a session&#8217;s own bundle from its model chip.
          </p>
          <div className="mb-scope">
            {sections.map((s) => {
              const map = s.folder ? models.perFolder : models.perSection;
              const key = s.folder ?? s.id;
              return (
                <label key={s.id} className="mb-scope__row">
                  <span className="mb-scope__name">
                    {s.name}
                    {s.folder ? <span className="mb-scope__kind"> folder</span> : null}
                  </span>
                  <select
                    aria-label={`Bundle for ${s.name}`}
                    value={map[key] ?? ''}
                    onChange={(e) => {
                      const next = { ...map };
                      if (e.target.value) next[key] = e.target.value;
                      else delete next[key];
                      save(
                        s.folder ? { ...models, perFolder: next } : { ...models, perSection: next },
                      );
                    }}
                  >
                    <option value="">Use the default</option>
                    {models.bundles.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.emoji ? `${b.emoji} ` : ''}
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            {Object.entries(models.perSession).map(([sid, bid]) => (
              <div key={sid} className="mb-scope__row">
                <span className="mb-scope__name">
                  {dms.find((d) => d.id === sid)?.name ?? 'A closed session'}
                  <span className="mb-scope__kind"> session</span>
                </span>
                <span className="mb-scope__val">
                  {models.bundles.find((b) => b.id === bid)?.name}
                </span>
                <button
                  type="button"
                  className="btn sec"
                  onClick={() => {
                    const perSession = { ...models.perSession };
                    delete perSession[sid];
                    save({ ...models, perSession });
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>Labels</h3>
      <p className="pf-hint">
        What the model chip says. A model&#8217;s own label wins. Otherwise the Cloud or Local
        template applies, with {'{name}'} for the model&#8217;s name. Local means the session talks
        to an API on this Mac.
      </p>
      <div className="pf-row">
        <label className="pf">
          <span>Cloud models</span>
          <input
            data-testid="label-tpl-cloud"
            value={models.groupLabels.cloud}
            maxLength={48}
            onChange={(e) =>
              save({ ...models, groupLabels: { ...models.groupLabels, cloud: e.target.value } })
            }
          />
        </label>
        <label className="pf">
          <span>Local models</span>
          <input
            data-testid="label-tpl-local"
            value={models.groupLabels.local}
            maxLength={48}
            onChange={(e) =>
              save({ ...models, groupLabels: { ...models.groupLabels, local: e.target.value } })
            }
          />
        </label>
      </div>
      {labelIds.length > 0 && (
        <div className="mb-labels">
          {labelIds.map((id) => {
            const l = models.labels[id] ?? {};
            const put = (patch: Partial<typeof l>) => {
              const next = { ...l, ...patch };
              const labels = { ...models.labels };
              if (!next.text && !next.emoji && !next.place) delete labels[id];
              else labels[id] = next;
              save({ ...models, labels });
            };
            const cloudDefault = cat.models.find((m) => m.id === id)?.where !== 'local';
            const place: ModelPlace = l.place ?? (cloudDefault ? 'cloud' : 'local');
            return (
              <div key={id} className="mb-label" data-label-model={id}>
                <span className="mb-label__name" title={id}>
                  {modelName(cat, id)}
                </span>
                <input
                  className="mb-label__emoji"
                  aria-label={`Emoji for ${modelName(cat, id)}`}
                  value={l.emoji ?? ''}
                  maxLength={16}
                  placeholder="Emoji"
                  onChange={(e) => put({ emoji: e.target.value || undefined })}
                />
                <input
                  className="mb-label__text"
                  aria-label={`Label for ${modelName(cat, id)}`}
                  value={l.text ?? ''}
                  maxLength={48}
                  placeholder="Own label"
                  onChange={(e) => put({ text: e.target.value || undefined })}
                />
                <div className="pf-seg" role="radiogroup" aria-label={`Where ${id} runs`}>
                  {(['cloud', 'local'] as const).map((p) => (
                    <label key={p} className="pf-seg__opt">
                      <input
                        type="radio"
                        name={`place-${id}`}
                        checked={place === p}
                        onChange={() => put({ place: p })}
                      />
                      <span>{p === 'cloud' ? 'Cloud' : 'Local'}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BundleCard({
  bundle,
  catalog,
  isDefault,
  onChange,
  onRemove,
  onMakeDefault,
}: {
  bundle: ModelBundle;
  catalog: ModelCatalog;
  isDefault: boolean;
  onChange(b: ModelBundle): void;
  onRemove(): void;
  onMakeDefault(): void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setEntry = (e: BundleEntry) =>
    onChange({ ...bundle, entries: bundle.entries.map((x) => (x.id === e.id ? e : x)) });
  const addEntry = () => {
    const e: BundleEntry = { id: newId('m'), tool: 'claude-code', model: 'claude-sonnet-4-6' };
    onChange({ ...bundle, entries: [...bundle.entries, e] });
  };
  const removeEntry = (id: string) => {
    const entries = bundle.entries.filter((x) => x.id !== id);
    if (entries.length === 0) return;
    onChange({
      ...bundle,
      entries,
      defaultEntry: bundle.defaultEntry === id ? entries[0].id : bundle.defaultEntry,
    });
  };
  return (
    <fieldset className="mb-card" data-bundle={bundle.id}>
      <legend className="sr-only">{bundle.name}</legend>
      <div className="mb-card__head">
        <input
          className="mb-card__emoji"
          aria-label="Bundle emoji"
          value={bundle.emoji ?? ''}
          maxLength={16}
          placeholder="Emoji"
          onChange={(e) => onChange({ ...bundle, emoji: e.target.value || null })}
        />
        <input
          className="mb-card__name"
          aria-label="Bundle name"
          value={bundle.name}
          maxLength={48}
          onChange={(e) => onChange({ ...bundle, name: e.target.value })}
          onBlur={(e) => !e.target.value.trim() && onChange({ ...bundle, name: 'Bundle' })}
        />
        {isDefault ? (
          <span className="mb-card__tag">Default bundle</span>
        ) : (
          <button type="button" className="btn sec" onClick={onMakeDefault}>
            Make default
          </button>
        )}
        <button
          type="button"
          className="btn sec"
          aria-expanded={confirmDelete}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
        {confirmDelete && (
          <div className="mb-card__confirm" role="alert">
            <span>
              Delete {bundle.name}? Sections, folders and sessions that use it go back to the
              default.
            </span>
            <button
              type="button"
              className="btn sec"
              onClick={onRemove}
              data-testid="bundle-delete"
            >
              Delete
            </button>
            <button type="button" className="btn sec" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </div>
        )}
      </div>
      <div className="mb-entries" role="list">
        {bundle.entries.map((e) => (
          <EntryRow
            key={e.id}
            entry={e}
            catalog={catalog}
            isDefault={bundle.defaultEntry === e.id}
            only={bundle.entries.length === 1}
            group={bundle.id}
            onChange={setEntry}
            onDefault={() => onChange({ ...bundle, defaultEntry: e.id })}
            onRemove={() => removeEntry(e.id)}
          />
        ))}
      </div>
      <div className="pf-row">
        <button type="button" className="btn sec" data-testid="entry-add" onClick={addEntry}>
          Add a model
        </button>
      </div>
    </fieldset>
  );
}

const CUSTOM = '__custom__';

function EntryRow({
  entry,
  catalog,
  isDefault,
  only,
  group,
  onChange,
  onDefault,
  onRemove,
}: {
  entry: BundleEntry;
  catalog: ModelCatalog;
  isDefault: boolean;
  only: boolean;
  group: string;
  onChange(e: BundleEntry): void;
  onDefault(): void;
  onRemove(): void;
}) {
  const choices = catalog.models.filter((m) => m.tool === entry.tool);
  const latest = families(catalog, entry.tool);
  const known =
    choices.some((m) => m.id === entry.model) ||
    latest.some((f) => `${LATEST_PREFIX}${f.family}` === entry.model);
  const [custom, setCustom] = useState(!known);
  const [text, setText] = useState(entry.model);
  const bad = custom && !safeModel(text);
  const adapter = ADAPTERS[entry.tool];
  return (
    <div className="mb-entry" role="listitem" data-entry={entry.id}>
      <label className="mb-entry__def" title="New sessions start on this model">
        <input type="radio" name={`def-${group}`} checked={isDefault} onChange={onDefault} />
        <span>Default</span>
      </label>
      <select
        aria-label="Tool"
        value={entry.tool}
        onChange={(e) => onChange({ ...entry, tool: e.target.value as ToolId })}
      >
        {TOOL_IDS.map((t) => (
          <option key={t} value={t}>
            {ADAPTERS[t].name}
            {ADAPTERS[t].ready ? '' : ' (coming)'}
          </option>
        ))}
      </select>
      <select
        aria-label="Model"
        value={custom ? CUSTOM : entry.model}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange({ ...entry, model: e.target.value });
        }}
      >
        {latest.length > 0 && (
          <optgroup label="Always the newest">
            {latest.map((f) => (
              <option key={f.family} value={`${LATEST_PREFIX}${f.family}`}>
                {modelName(catalog, `${LATEST_PREFIX}${f.family}`)} (now {f.name})
              </option>
            ))}
          </optgroup>
        )}
        {choices.length > 0 && (
          <optgroup label="A fixed model">
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={CUSTOM}>Other model string...</option>
      </select>
      {custom && (
        <input
          className="mb-entry__text"
          aria-label="Model string"
          aria-invalid={bad}
          value={text}
          spellCheck={false}
          placeholder="claude-opus-4-8[1m]"
          onChange={(e) => {
            setText(e.target.value);
            if (safeModel(e.target.value)) onChange({ ...entry, model: e.target.value });
          }}
        />
      )}
      <button
        type="button"
        className="btn sec"
        disabled={only}
        aria-label="Remove this model"
        onClick={onRemove}
      >
        Remove
      </button>
      {bad && (
        <p className="pf-err mb-entry__msg">
          Letters, digits and . _ - : / @ [ ] only, no spaces. It is typed into the terminal.
        </p>
      )}
      {!adapter.ready && (
        <p className="pf-hint mb-entry__msg">
          {adapter.name} support comes later. Patchroom keeps the model, but cannot launch or switch
          it yet.
        </p>
      )}
    </div>
  );
}
