import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LocalEngineConnectionProvider } from './LocalEngineConnectionProvider.tsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LocalEngineConnectionProvider>
      <App />
    </LocalEngineConnectionProvider>
  </StrictMode>,
)
