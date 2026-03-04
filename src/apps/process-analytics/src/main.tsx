import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessAnalyticsApp from './App.tsx'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element not found')
}
createRoot(root).render(
  <StrictMode>
    <ProcessAnalyticsApp />
  </StrictMode>,
)
