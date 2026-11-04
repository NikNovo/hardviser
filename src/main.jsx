import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initializeAppearance } from './appearance.js';
import './design-tokens.css';
import './fonts.css';
import './styles.css';

initializeAppearance();

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
