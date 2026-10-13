import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/theme/index.css';
import './preview.css';
import { App } from './App.tsx';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
