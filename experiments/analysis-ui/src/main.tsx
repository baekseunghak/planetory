import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ObservationApp } from './ObservationApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('scenario') ? <App /> : <ObservationApp />}
  </StrictMode>,
);
