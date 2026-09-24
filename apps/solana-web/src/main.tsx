import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientProvider } from '@solana/react';
import { App } from './App';
import { solanaKitClient } from './solanaClient';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientProvider client={solanaKitClient}>
      <App />
    </ClientProvider>
  </StrictMode>,
);
