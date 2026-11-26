import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { Boundary } from './shell/boundary.js';
import './style.css';
import { followTheme } from './shared/theme.js';
followTheme();
const element = document.getElementById('root');
if (!element) throw new Error('Workspace root missing');
createRoot(element).render(
  <Boundary>
    <App />
  </Boundary>,
);
