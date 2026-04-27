import { useEffect } from 'react'
import { initStore, startRecycleBinJanitor } from './store'
import { useStore } from './store'
import { normalizeBaseUrl } from './lib/api'
import type { ApiProtocol, RequestMode, ResponsesImageInputMode, ResponsesTransportMode } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import ImageContextMenu from './components/ImageContextMenu'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)

  useEffect(() => {
    const isApiProtocol = (value: string): value is ApiProtocol =>
      value === 'auto' || value === 'images' || value === 'responses'
    const isRequestMode = (value: string): value is RequestMode =>
      value === 'direct' || value === 'local_proxy'
    const isResponsesTransportMode = (value: string): value is ResponsesTransportMode =>
      value === 'auto' || value === 'stream' || value === 'json'
    const isResponsesImageInputMode = (value: string): value is ResponsesImageInputMode =>
      value === 'auto' || value === 'file_id'

    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings: {
      baseUrl?: string
      apiKey?: string
      apiProtocol?: ApiProtocol
      requestMode?: RequestMode
      responsesTransport?: ResponsesTransportMode
      responsesImageInputMode?: ResponsesImageInputMode
    } = {}

    const apiUrlParam = searchParams.get('apiUrl')
    if (apiUrlParam !== null) {
      nextSettings.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
    }

    const apiKeyParam = searchParams.get('apiKey')
    if (apiKeyParam !== null) {
      nextSettings.apiKey = apiKeyParam.trim()
    }

    const apiProtocolParam = searchParams.get('apiProtocol')
    if (apiProtocolParam !== null && isApiProtocol(apiProtocolParam.trim())) {
      nextSettings.apiProtocol = apiProtocolParam.trim()
    }

    const requestModeParam = searchParams.get('requestMode')
    if (requestModeParam !== null && isRequestMode(requestModeParam.trim())) {
      nextSettings.requestMode = requestModeParam.trim()
    }

    const responsesTransportParam = searchParams.get('responsesTransport')
    if (responsesTransportParam !== null && isResponsesTransportMode(responsesTransportParam.trim())) {
      nextSettings.responsesTransport = responsesTransportParam.trim()
    }

    const responsesImageInputModeParam = searchParams.get('responsesImageInputMode')
    if (
      responsesImageInputModeParam !== null &&
      isResponsesImageInputMode(responsesImageInputModeParam.trim())
    ) {
      nextSettings.responsesImageInputMode = responsesImageInputModeParam.trim()
    }

    if (Object.keys(nextSettings).length > 0) {
      setSettings(nextSettings)

      searchParams.delete('apiUrl')
      searchParams.delete('apiKey')
      searchParams.delete('apiProtocol')
      searchParams.delete('requestMode')
      searchParams.delete('responsesTransport')
      searchParams.delete('responsesImageInputMode')

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
    const stopRecycleBinJanitor = startRecycleBinJanitor()

    return () => {
      stopRecycleBinJanitor()
    }
  }, [setSettings])

  return (
    <>
      <Header />
      <main className="max-w-7xl mx-auto px-4 pb-48">
        <SearchBar />
        <TaskGrid />
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      <ImageContextMenu />
    </>
  )
}
