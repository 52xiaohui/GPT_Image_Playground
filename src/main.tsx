import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const APP_CACHE_PREFIX = 'gpt-image-playground'

async function clearLegacyAppCaches() {
  if (!('caches' in window)) return
  const cacheKeys = await caches.keys()
  await Promise.all(
    cacheKeys
      .filter((cacheKey) => cacheKey.startsWith(APP_CACHE_PREFIX))
      .map((cacheKey) => caches.delete(cacheKey)),
  )
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then(() => clearLegacyAppCaches())
      .catch((error) => {
        console.error('Service worker cleanup failed:', error)
      })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
