import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LocalEngineConnectionProvider } from './LocalEngineConnectionProvider.tsx'
import { AppDialogProvider } from './components/common/AppDialog.tsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LocalEngineConnectionProvider>
      <AppDialogProvider>
        <App />
      </AppDialogProvider>
    </LocalEngineConnectionProvider>
  </StrictMode>,
)
