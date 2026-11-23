import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { Boundary } from './boundary.js';
import './style.css';
const element = document.getElementById('root');
if (!element) throw new Error('Workspace root missing');
createRoot(element).render(
  <Boundary>
    <App />
  </Boundary>,
);
