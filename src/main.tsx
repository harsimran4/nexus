import { createRoot } from 'react-dom/client'
import { App } from './App'
import './ui/styles.css'

// Apply the stored theme before first paint (no flash of the wrong theme).
const storedTheme = localStorage.getItem('nexus.theme')
if (storedTheme === 'dark') {
  document.documentElement.dataset.theme = 'dark'
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'dark')
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
