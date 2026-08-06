import { useState, useEffect } from 'react'
import FileExplorer from './components/FileExplorer'
import MarkdownViewer from './components/MarkdownViewer'
import PlantUMLViewer from './components/PlantUMLViewer'
import SimulationViewer from './components/SimulationViewer'
import { useTheme } from './components/ThemeProvider'
import { loadIndex, findDocById } from './services/fileService'

export default function App() {
  const [tree, setTree] = useState([])
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [error, setError] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()

  useEffect(() => {
    loadIndex()
      .then(data => {
        setTree(data)
        const id = window.location.hash.slice(1)
        const doc = id ? findDocById(data, id) : null
        setSelectedDoc(doc || data.find(n => !n.children) || null)
      })
      .catch(err => setError(err.message))
  }, [])

  useEffect(() => {
    function onHashChange() {
      const id = window.location.hash.slice(1)
      if (!id) return
      const doc = findDocById(tree, id)
      if (doc) setSelectedDoc(doc)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [tree])

  function handleSelect(doc) {
    window.location.hash = doc.id
    setSelectedDoc(doc)
    setNavOpen(false)
  }

  return (
    <div className="app">
      {navOpen && <div className="overlay" onClick={() => setNavOpen(false)} />}
      <aside className={`rail ${navOpen ? 'rail-open' : ''}`}>
        <div className="rail-mark">
          <span className="eyebrow">Boku · Banking &amp; Settlement</span>
          <strong>Payouts API</strong>
        </div>
        {error && <p className="error">{error}</p>}
        <FileExplorer tree={tree} selected={selectedDoc} onSelect={handleSelect} />
        <div className="rail-tools">
          <span className="rail-tools-label">Tools</span>
          <a className="rail-tools-link" href="/api-docs/?server=https://mywiremockserver-production.up.railway.app" target="_blank" rel="noopener noreferrer">
            API Playground ↗
          </a>
        </div>
        <div className="rail-footer">
          <button className="theme-toggle-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀ Light' : '☽ Dark'}
          </button>
        </div>
      </aside>
      <main className="viewer">
        <button className="menu-btn" onClick={() => setNavOpen(o => !o)} aria-label="Toggle navigation">☰</button>
        {!selectedDoc && <p className="placeholder">Select a document to view</p>}
        {selectedDoc?.type === 'markdown' && <MarkdownViewer doc={selectedDoc} />}
        {selectedDoc?.type === 'plantuml' && <PlantUMLViewer doc={selectedDoc} />}
        {selectedDoc?.type === 'simulation' && <SimulationViewer />}
      </main>
    </div>
  )
}
