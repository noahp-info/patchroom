import { useState } from 'react';
import { accountActions, useClaudeAccount } from '../../lib/accounts';
import { formatStamp } from '../../lib/time';

/**
 * Settings > Accounts: the sites the side pane is signed in to. One place to sign in to
 * claude.ai, once, so every artifact opens in the pane until claude.ai ends the sign-in.
 */
export function AccountsSection() {
  const acct = useClaudeAccount();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const state =
    acct.signedIn === true
      ? 'Signed in'
      : acct.signedIn === false
        ? 'Not signed in'
        : 'Not checked yet';
  return (
    <div className="pf-section" data-testid="prefs-accounts">
      <h2>Accounts</h2>
      <p className="pf-hint">
        Sign in once and claude.ai artifacts open right in the side pane. The sign-in stays in the
        pane&#8217;s own storage, apart from the rest of Patchroom, until claude.ai ends it.
      </p>
      <div className="acct" data-testid="account-claude" data-state={String(acct.signedIn)}>
        <div className="acct__who">
          <b>claude.ai</b>
          <span className="acct__state" role="status">
            {state}
            {acct.at !== null && (
              <span className="acct__when"> &#183; last seen {formatStamp(acct.at)}</span>
            )}
          </span>
        </div>
        <div className="acct__btns">
          {acct.signedIn !== true && (
            <button type="button" className="btn pri" onClick={() => accountActions().signIn()}>
              Sign in
            </button>
          )}
          {acct.signedIn === true && (
            <button
              type="button"
              className="btn sec"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void accountActions()
                  .signOut()
                  .then(setNote, (e: unknown) => setNote(`Could not sign out: ${String(e)}`))
                  .finally(() => setBusy(false));
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </div>
      <p className="pf-hint" role="status" data-testid="account-note">
        {note ||
          'Patchroom never reads your claude.ai cookies. It shows what the last claude.ai page in the pane said.'}
      </p>
    </div>
  );
}
