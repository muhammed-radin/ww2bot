import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { ThemeProvider } from '@/hooks/use-theme.jsx';
import { AuthProvider } from '@/hooks/use-auth.jsx';
import { Toaster } from '@/components/ui/sonner.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <HashRouter>
        <AuthProvider>
          <App />
          <Toaster />
        </AuthProvider>
      </HashRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
