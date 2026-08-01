import { useState, useEffect } from 'react'
import { loadDocument } from '../services/fileService'
import { renderMarkdown } from '../services/renderService'

export default function MarkdownViewer({ doc }) {
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    loadDocument(doc.path)
      .then(content => {
        setHtml(renderMarkdown(content))
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
      <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
