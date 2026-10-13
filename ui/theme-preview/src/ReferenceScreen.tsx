import { useId, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { PatchCable, themeVars } from '../../src/theme/index.ts';
import type { BaseId, Theme, ThemeMode } from '../../src/theme/index.ts';

type Presence = 'busy' | 'idle' | 'needs' | 'err';
type Provider = 'claude' | 'cursor' | 'codex';

function Icon({ id }: { id: string }) {
  return (
    <svg className="i" aria-hidden="true">
      <use href={`#i-${id}`} />
    </svg>
  );
}

function Glyph({ provider, size }: { provider: Provider; size?: number }) {
  return (
    <svg
      className={`pg ${provider}`}
      aria-hidden="true"
      style={size ? { width: size, height: size } : undefined}
    >
      <use href={`#p-${provider}`} />
    </svg>
  );
}

const hold = (e: MouseEvent) => e.preventDefault();

interface RowProps {
  name: string;
  presence: Presence;
  provider: Provider;
  badge?: { kind: 'needs' | 'unr' | 'err'; text: string };
  active?: boolean;
  unread?: boolean;
  plugged?: boolean;
}

function SessionRow({ name, presence, provider, badge, active, unread, plugged }: RowProps) {
  return (
    <a
      className={`row${unread ? ' unread' : ''}${active ? ' active' : ''}`}
      href="#"
      onClick={hold}
      aria-current={active ? 'true' : undefined}
    >
      <span className={`dot ${presence}`} />
      <span className={`jack ${presence}${plugged ? ' plugged' : ''}`} />
      <Glyph provider={provider} />
      <span className="nm">{name}</span>
      {badge && <span className={`bdg ${badge.kind}`}>{badge.text}</span>}
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sec">
      <div className="sec-h">
        <Icon id="down" />
        {title}
      </div>
      {children}
    </div>
  );
}

const OPTIONS = [
  {
    label: 'Fall through to the TUI',
    detail: 'Return no decision; the terminal dialog shows as usual.',
    rec: true,
  },
  {
    label: 'Deny the tool call',
    detail: 'Safer when unattended, but the agent stalls until you retry.',
  },
  {
    label: 'Retry once, then fall through',
    detail: 'Waits 30s more for a slow app launch, then falls through.',
  },
];

function AskWidget() {
  const [sel, setSel] = useState(0);
  const qid = useId();
  return (
    <div className="ask">
      <div className="ask-h">
        Claude is asking <span className="needs-pill">Needs you</span>
      </div>
      <div className="ask-q" id={qid}>
        When the bridge times out, what should the hook do?
      </div>
      <ul className="opts" role="radiogroup" aria-labelledby={qid}>
        {OPTIONS.map((o, i) => (
          <li
            key={o.label}
            className={`opt${sel === i ? ' sel' : ''}`}
            role="radio"
            aria-checked={sel === i}
            tabIndex={0}
            onClick={() => setSel(i)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                setSel(i);
              }
            }}
          >
            <span className="radio" />
            <span className="k">{i + 1}</span>
            <span className="ol">{o.label}</span>
            {o.rec ? <span className="rec">Recommended</span> : <span />}
            <span className="od">{o.detail}</span>
          </li>
        ))}
      </ul>
      <div className="other">
        <span className="radio" />
        <span className="f">Other: describe what you want instead</span>
      </div>
      <div className="ask-f">
        <span className="hint">Your answer goes back through the hook.</span>
        <button type="button" className="btn sec">
          Answer in terminal
        </button>
        <button type="button" className="btn pri">
          Send answer
        </button>
      </div>
    </div>
  );
}

function Kw({ children }: { children: ReactNode }) {
  return <span className="kw">{children}</span>;
}
function Ty({ children }: { children: ReactNode }) {
  return <span className="ty">{children}</span>;
}
function Fn({ children }: { children: ReactNode }) {
  return <span className="fn">{children}</span>;
}
function Cm({ children }: { children: ReactNode }) {
  return <span className="cm">{children}</span>;
}

function Diff() {
  return (
    <table className="diff" aria-label="Diff of socket.rs">
      <tbody>
        <tr className="hunk">
          <td className="n" />
          <td className="n" />
          <td className="c">@@ -41,9 +41,17 @@ impl Bridge {'{'}</td>
        </tr>
        <tr>
          <td className="n">41</td>
          <td className="n">41</td>
          <td className="c">
            {'    '}
            <Kw>async fn</Kw> <Fn>serve</Fn>(&amp;<Kw>self</Kw>, <Kw>mut</Kw> stream:{' '}
            <Ty>UnixStream</Ty>) {'{'}
          </td>
        </tr>
        <tr>
          <td className="n">42</td>
          <td className="n">42</td>
          <td className="c">
            {'        '}
            <Kw>let</Kw> req = <Ty>HookRequest</Ty>::<Fn>read</Fn>(&amp;<Kw>mut</Kw> stream).
            <Kw>await</Kw>?;
          </td>
        </tr>
        <tr className="d">
          <td className="n">43</td>
          <td className="n" />
          <td className="c">
            -{'       '}
            <Kw>let</Kw> reply = <Kw>self</Kw>.<Fn>route</Fn>(req).<Kw>await</Kw>?;
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">43</td>
          <td className="c">
            +{'       '}
            <Kw>let</Kw> reply = <Kw>match</Kw> <Fn>timeout</Fn>(ASK_TIMEOUT,
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">44</td>
          <td className="c">
            +{'           '}
            <Kw>self</Kw>.<Fn>route</Fn>(req)).<Kw>await</Kw> {'{'}
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">45</td>
          <td className="c">
            +{'           '}
            <Ty>Ok</Ty>(r) =&gt; r?,
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">46</td>
          <td className="c">
            +{'           '}
            <Cm>// No client answered: return no</Cm>
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">47</td>
          <td className="c">
            +{'           '}
            <Cm>// decision so the TUI dialog runs.</Cm>
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">48</td>
          <td className="c">
            +{'           '}
            <Ty>Err</Ty>(_) =&gt; <Ty>HookReply</Ty>::NoDecision,
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">49</td>
          <td className="c">
            +{'       '}
            {'};'}
          </td>
        </tr>
        <tr>
          <td className="n">44</td>
          <td className="n">50</td>
          <td className="c">
            {'        '}reply.<Fn>write</Fn>(&amp;<Kw>mut</Kw> stream).<Kw>await</Kw>
          </td>
        </tr>
        <tr>
          <td className="n">45</td>
          <td className="n">51</td>
          <td className="c">{'    }'}</td>
        </tr>
        <tr className="hunk">
          <td className="n" />
          <td className="n" />
          <td className="c">@@ -88,4 +96,8 @@ const ASK_TIMEOUT</td>
        </tr>
        <tr className="d">
          <td className="n">88</td>
          <td className="n" />
          <td className="c">
            -<Kw>const</Kw> ASK_TIMEOUT: <Ty>Duration</Ty> = secs(<Ty>10</Ty>);
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">96</td>
          <td className="c">
            +<Kw>const</Kw> ASK_TIMEOUT: <Ty>Duration</Ty> = secs(<Ty>30</Ty>);
          </td>
        </tr>
        <tr className="a">
          <td className="n" />
          <td className="n">97</td>
          <td className="c">
            +<Cm>// Matches the TUI&apos;s own prompt wait.</Cm>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export interface ReferenceScreenProps {
  base: BaseId;
  theme: Theme;
  mode: ThemeMode;
  /** Fixed pixel size. Omit to fill the parent. */
  size?: { width: number; height: number };
}

/**
 * The reference screen from the design looks: sidebar with sections, presence and badges, a DM
 * with a tool call, an AskUserQuestion widget, a composer with chips, Stop and the status strip,
 * and an artifact pane. Base and theme arrive as props; nothing in here knows a color.
 */
export function ReferenceScreen({ base, theme, mode, size }: ReferenceScreenProps) {
  const style = {
    ...themeVars(theme, mode),
    colorScheme: mode,
    ...(size ? { '--app-w': `${size.width}px`, '--app-h': `${size.height}px` } : {}),
  } as CSSProperties;

  return (
    <div className="pr-app" data-base={base} data-mode={mode} data-theme={theme.id} style={style}>
      <div className="tb">
        <span className="screw" aria-hidden="true" />
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="tb-nav" aria-hidden="true">
          <Icon id="left" />
          <Icon id="right" />
        </span>
        <span className="tb-search">
          <Icon id="search" />
          <span>Search sessions, threads, artifacts</span>
          <kbd>&#8984;K</kbd>
        </span>
        <span className="tb-act">
          <Icon id="inbox" />
          Needs you <b>2</b>
        </span>
        <span className="screw" aria-hidden="true" />
      </div>

      <aside className="side" aria-label="Sessions">
        <div className="ws">
          <span className="ws-mark">P</span>
          <div>
            <strong>patchroom</strong>
            <small>~/code &middot; 7 sessions</small>
          </div>
          <button type="button" aria-label="New DM">
            <Icon id="pencil" />
          </button>
        </div>
        <div className="side-scroll">
          <a className="row" href="#" onClick={hold}>
            <Icon id="inbox" />
            <span className="nm">Activity</span>
            <span className="bdg needs">2</span>
          </a>
          <a className="row" href="#" onClick={hold}>
            <Icon id="thread" />
            <span className="nm">Threads</span>
          </a>
          <a className="row" href="#" onClick={hold}>
            <Icon id="pencil" />
            <span className="nm">Drafts</span>
            <span className="ct">2</span>
          </a>

          <Section title="Starred">
            <SessionRow name="api-refactor" presence="busy" provider="claude" />
          </Section>
          <Section title="Channels">
            <a className="row unread" href="#" onClick={hold}>
              <Icon id="hash" />
              <span className="nm">release-0.1</span>
              <span className="bdg unr">4</span>
            </a>
            <a className="row" href="#" onClick={hold}>
              <Icon id="hash" />
              <span className="nm">flaky-tests</span>
            </a>
          </Section>
          <Section title="Direct messages">
            <SessionRow
              name="hook-bridge"
              presence="needs"
              provider="claude"
              badge={{ kind: 'needs', text: '1' }}
              active
              plugged
            />
            <SessionRow
              name="sidebar-dnd"
              presence="busy"
              provider="cursor"
              badge={{ kind: 'unr', text: '3' }}
              unread
            />
            <SessionRow
              name="theme-import"
              presence="needs"
              provider="claude"
              badge={{ kind: 'needs', text: '1' }}
            />
            <SessionRow name="onboarding-scan" presence="idle" provider="codex" />
            <SessionRow
              name="pty-resize"
              presence="err"
              provider="claude"
              badge={{ kind: 'err', text: '!' }}
            />
            <SessionRow
              name="docs-pass"
              presence="idle"
              provider="claude"
              badge={{ kind: 'unr', text: '2' }}
              unread
            />
          </Section>
        </div>
        <div className="side-foot">
          <span>Archived 14</span>
          <span>&#8984;&#8679;A next</span>
        </div>
      </aside>

      <main className="conv">
        <header className="ch">
          <span className="jack needs plugged" data-jack-to="" />
          <h2>
            <Glyph provider="claude" />
            hook-bridge
          </h2>
          <span className="fid">Full</span>
          <span className="meta">
            <span>
              <Icon id="folder" />
              ~/code/patchroom
            </span>
            <span>
              <Icon id="branch" />
              wt/hook-bridge
            </span>
          </span>
          <span className="tools">
            <button type="button">
              <Icon id="term" />
              Terminal <kbd>&#8984;J</kbd>
            </button>
            <button type="button" aria-label="Pin">
              <Icon id="pin" />
            </button>
            <button type="button" aria-label="More">
              <Icon id="more" />
            </button>
          </span>
        </header>

        <div className="log">
          <div className="msg user">
            <div className="av user">
              <span>NP</span>
            </div>
            <div className="who">
              <b>Noah</b>
              <time>10:42</time>
            </div>
            <div className="body">
              <p>
                Wire the AskUserQuestion PreToolUse hook through the bridge. If no client is
                attached, return no decision so the TUI dialog still shows.
              </p>
            </div>
          </div>

          <div className="msg bot">
            <div className="av bot">
              <Glyph provider="claude" />
            </div>
            <div className="who">
              <b>Claude</b>
              <time>10:46</time>
            </div>
            <div className="body">
              <p>
                Done. <code>patchroom-hook</code> now forwards the PreToolUse payload to{' '}
                <code>bridge.sock</code> and waits up to 30s for an answer. With no client attached
                it <mark className="hl">exits 0 with an empty body</mark>, so Claude Code falls
                through to its own dialog.
              </p>
              <div className="tool">
                <span className="pre">&#9679;</span>
                <span className="tn">Bash</span>
                <code>pnpm test --filter bridge</code>
                <span className="ok">
                  <Icon id="check" />
                  42 passed
                </span>
                <span className="dur">3.1s</span>
                <Icon id="chev" />
              </div>
              <div className="thread">
                <span className="stack">
                  <span>
                    <Glyph provider="claude" size={12} />
                  </span>
                  <span>
                    <Glyph provider="claude" size={12} />
                  </span>
                </span>
                <span>
                  <a href="#" onClick={hold}>
                    Subagent: race-check
                  </a>{' '}
                  <span className="tx">Explore &middot; 4 replies &middot; 2m ago</span>
                  <span className="sum">
                    No race when the TUI answers first; the hook drops the late bridge reply.
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="msg bot">
            <div className="av bot">
              <Glyph provider="claude" />
            </div>
            <div className="who">
              <b>Claude</b>
              <time>10:47</time>
            </div>
            <div className="body">
              <AskWidget />
            </div>
          </div>
        </div>

        <div className="composer">
          <div className="chips">
            <button type="button" className="chip c1">
              <i />
              Approve plan
            </button>
            <button type="button" className="chip c2">
              <i />
              Revise
            </button>
            <button type="button" className="chip c3">
              <i />
              Show diff
            </button>
            <span className="ctx">Chips prefill; nothing sends until you press Send</span>
          </div>
          <div className="box">
            <div className="queued">
              <span className="qq">exits 0 with an empty body</span>
              <span className="qc">Log a warning to bridge.log when this happens.</span>
              <button type="button" aria-label="Jump to quote">
                <Icon id="link" />
              </button>
              <button type="button" aria-label="Remove comment">
                <Icon id="x" />
              </button>
            </div>
            <div className="input">
              <span className="caret" />
              Message hook-bridge
            </div>
            <div className="bar">
              <button type="button" className="ib" aria-label="Attach">
                <Icon id="clip" />
              </button>
              <button type="button" className="ib" aria-label="Screenshot to steer">
                <Icon id="shot" />
              </button>
              <button type="button" className="ib" aria-label="Slash commands">
                <Icon id="slash" />
              </button>
              <span className="sp" />
              <button type="button" className="stop">
                <i />
                Stop <kbd>esc</kbd>
              </button>
              <button type="button" className="send" aria-label="Send">
                <Icon id="send" />
              </button>
            </div>
          </div>
        </div>
        <div className="strip">
          <span className="sc">Opus 4.8</span>
          <span className="sc">
            <Icon id="folder" />
            patchroom
          </span>
          <span className="sc">
            <span className="meter" />
            ctx 64%
          </span>
          <span className="sc">$1.82</span>
          <span className="sc mode">accept edits</span>
          <span className="sc">
            <Icon id="pr" />
            PR #14
          </span>
          <span className="verb">wt/hook-bridge &middot; 42 tests ok &middot; CI 37m left</span>
        </div>
      </main>

      <aside className="art" aria-label="Artifacts">
        <div className="art-tabs">
          <span className="on">
            <Icon id="file" />
            socket.rs
          </span>
          <span>
            <Icon id="globe" />
            localhost:5173
          </span>
          <span>
            <Icon id="file" />
            SPEC.md
          </span>
        </div>
        <div className="art-sheet">
          <div className="art-h">
            <b>crates/bridge/src/socket.rs</b>
            <span className="st">
              <span className="a">+38</span> <span className="d">&minus;6</span>
            </span>
          </div>
          <Diff />
          <div className="art-note">
            Highlight any line to comment on it <kbd>&#8984;&#8679;2</kbd>
          </div>
        </div>
      </aside>
      <PatchCable remeasureKey={`${base}/${theme.id}/${mode}`} />
    </div>
  );
}
