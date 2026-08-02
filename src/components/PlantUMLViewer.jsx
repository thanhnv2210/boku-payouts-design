import { useState, useEffect } from 'react'
import { loadDocument } from '../services/fileService'
import { encodePlantUML, getPlantUMLUrl } from '../services/renderService'

export default function PlantUMLViewer({ doc }) {
  const [url, setUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    loadDocument(doc.path)
      .then(async text => {
        const enc = await encodePlantUML(text)
        setUrl(getPlantUMLUrl(enc))
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [doc.path])

  if (loading) return <p className="loading">Loading…</p>
  if (error) return <p className="error">{error}</p>

  return (
    <div className="viewer-content">
      <div className="plantuml-wrap">
        <img className="plantuml-img" src={url} alt={doc.title} />
      </div>
    </div>
  )
}
