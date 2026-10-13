import { Terminal } from './components/Terminal';

export function App() {
  return (
    <main className="shell">
      <header className="shell__header">
        <h1>Patchroom</h1>
        <p>Every DM is a real terminal.</p>
      </header>
      <section className="shell__terminal" aria-label="Terminal placeholder">
        <Terminal />
      </section>
    </main>
  );
}
