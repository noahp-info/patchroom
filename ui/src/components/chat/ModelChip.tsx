import { useState } from 'react';
import type { BundleEntry, Prefs, SessionStatus, StatusChips } from '../../ipc';
import { adapterOf, modelTook } from '../../lib/models/adapters';
import { activeBundle, modelLabel, modelsOf, type BundleSource } from '../../lib/models/bundles';
import { modelName, resolveModel } from '../../lib/models/catalog';
import type { AppStore, ModelSwitch } from '../../state/store';
import { Floating } from '../Floating';
import { Icon } from '../Icon';

const SOURCE: Record<BundleSource, string> = {
  session: 'This session',
  section: 'From its section',
  folder: 'From its folder',
  default: 'Your default bundle',
};

export interface ModelChipProps {
  store: AppStore;
  sessionId: string;
  chips: StatusChips;
  status: SessionStatus;
  prefs: Prefs | null;
  switching?: ModelSwitch;
}

/**
 * The status strip's model module. It shows the model's label (its own, else the Cloud or Local
 * template, else the name) and opens a picker limited to the session's bundle. A switch types the
 * tool's command only while the session is idle, then waits for the CLI to report the model.
 */
export function ModelChip({ store, sessionId, chips, status, prefs, switching }: ModelChipProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const { catalog, sessions } = store.getSnapshot();
  const models = modelsOf(prefs);
  const label = modelLabel(models, catalog, chips);
  const scope = store.scopeOf(sessionId);
  const found = activeBundle(models, scope);
  const idle = status === 'idle';
  const askChecks =
    !(prefs?.updates?.askedModels ?? false) && !(prefs?.updates?.checkModels ?? false);
  const session = sessions.find((s) => s.id === sessionId);

  const current = (e: BundleEntry) => modelTook(resolveModel(catalog, e.tool, e.model), chips);

  return (
    <>
      <button
        type="button"
        className="sc mode model-chip"
        data-chip="model"
        data-testid="model-chip"
        data-state={switching?.state}
        data-place={label.place}
        aria-haspopup="dialog"
        aria-expanded={rect !== null}
        title={
          switching?.state === 'error'
            ? switching.message
            : `${chips.model ?? chips.modelId ?? 'Model'}: switch models`
        }
        onClick={(e) => setRect(rect ? null : e.currentTarget.getBoundingClientRect())}
      >
        {switching?.state === 'pending' ? (
          <span>Switching to {modelName(catalog, switching.target)}</span>
        ) : (
          <span className="model-chip__t">{label.text}</span>
        )}
      </button>
      {rect && (
        <Floating anchor={rect} label="Models" className="pop mpick" onClose={() => setRect(null)}>
          <h3 className="pop__h">Models</h3>
          {found ? (
            <>
              <p className="mpick__src" data-testid="mpick-bundle">
                {found.bundle.emoji ? `${found.bundle.emoji} ` : ''}
                {found.bundle.name}
                <span className="mpick__src-why"> · {SOURCE[found.source]}</span>
              </p>
              <div className="mpick__list" role="listbox" aria-label="Models in this bundle">
                {found.bundle.entries.map((e) => {
                  const on = current(e);
                  const ad = adapterOf(e.tool);
                  const canSwitch = idle && !!ad?.ready && !on && switching?.state !== 'pending';
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className="mpick__opt"
                      data-entry={e.id}
                      disabled={!canSwitch && !on}
                      onClick={() => {
                        if (on) return;
                        void store.switchModel(sessionId, e);
                      }}
                    >
                      <span className="mpick__name">{modelName(catalog, e.model, e.tool)}</span>
                      <span className="mpick__meta">
                        {e.id === found.bundle.defaultEntry && (
                          <span className="mpick__tag">Default</span>
                        )}
                        {ad && e.tool !== 'claude-code' && (
                          <span className="mpick__tag">{ad.name}</span>
                        )}
                        {on && <Icon name="check" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {!idle && (
                <p className="mpick__note" data-testid="mpick-busy">
                  Switch when Claude is idle. A switch never interrupts a turn.
                </p>
              )}
            </>
          ) : (
            <p className="mpick__note" data-testid="mpick-empty">
              No bundle applies here yet. A bundle is the set of models you switch between.
            </p>
          )}
          {switching && (
            <p
              className={`mpick__note${switching.state === 'error' ? ' mpick__err' : ''}`}
              role={switching.state === 'error' ? 'alert' : 'status'}
              data-testid="mpick-switch"
            >
              {switching.state === 'pending'
                ? `Switching to ${modelName(catalog, switching.target)}. Waiting for Claude to confirm.`
                : switching.message}
            </p>
          )}
          {models.bundles.length > 0 && (
            <label className="mpick__bundle">
              <span>Bundle for this session</span>
              <select
                value={models.perSession[sessionId] ?? ''}
                data-testid="mpick-bundle-select"
                onChange={(e) => void store.setSessionBundle(sessionId, e.target.value || null)}
              >
                <option value="">
                  {session?.sectionId && models.perSection[session.sectionId]
                    ? 'Follow its section'
                    : 'Follow the default'}
                </option>
                {models.bundles.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.emoji ? `${b.emoji} ` : ''}
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {askChecks && <ModelChecksAsk store={store} />}
          <div className="mpick__foot">
            <button
              type="button"
              className="btn sec"
              data-testid="mpick-manage"
              onClick={() => {
                setRect(null);
                store.openPrefs({ tab: 'models' });
              }}
            >
              {models.bundles.length ? 'Manage bundles' : 'Make a bundle'}
            </button>
          </div>
        </Floating>
      )}
    </>
  );
}

/** The one-time question: fetch newer model lists between builds? Nothing fetches until yes. */
export function ModelChecksAsk({ store }: { store: AppStore }) {
  return (
    <div className="mask" role="group" aria-label="Check for newer models" data-testid="model-ask">
      <p className="mask__q">Want to check for newer models?</p>
      <p className="mask__why">
        Patchroom would download a signed model list now and then. It sends nothing about you.
      </p>
      <div className="mask__btns">
        <button
          type="button"
          className="btn pri"
          data-testid="model-ask-on"
          onClick={() => void store.answerModelChecks(true)}
        >
          Turn on
        </button>
        <button
          type="button"
          className="btn sec"
          data-testid="model-ask-later"
          onClick={() => void store.answerModelChecks(false)}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
