import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { I18nProvider } from './i18n'
import './styles.css'

const raiz = document.getElementById('root')
if (!raiz) throw new Error('#root element not found')

createRoot(raiz).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
