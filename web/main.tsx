import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './style.css';
const element = document.getElementById('root');
if (!element) throw new Error('Workspace root missing');
createRoot(element).render(<App />);
