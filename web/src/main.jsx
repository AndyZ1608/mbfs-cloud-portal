import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LocaleProvider } from './i18n/react.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<LocaleProvider><App /></LocaleProvider>);
