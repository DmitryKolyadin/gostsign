import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { configure } from '@gostsign/core';
import './styles.css';
import App from './App.tsx';

// ассеты ядра копируются в public/ скриптом copy-core-assets
configure({ assetsBaseUrl: import.meta.env.BASE_URL });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
