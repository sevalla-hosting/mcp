import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessAnalyticsApp from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProcessAnalyticsApp />
  </StrictMode>,
)
