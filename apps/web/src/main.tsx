import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme, watchTabVisibility } from './hooks';
import './tokens.css';
import './base.css';
import './home.css';
import './dash.css';
import './wizard.css';

// The theme is set before the first render so the page does not flash the wrong colours.
initTheme();
watchTabVisibility();

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
