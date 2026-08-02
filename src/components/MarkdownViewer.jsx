import { useState, useEffect, useRef } from 'react'
import { loadDocument } from '../services/fileService'
import { renderMarkdown } from '../services/renderService'

export default function MarkdownViewer({ doc }) {
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const articleRef = useRef(null)

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

  // Wide tables scroll horizontally in their own wrapper instead of squeezing the page
  useEffect(() => {
    if (loading || !articleRef.current) return
    articleRef.current.querySelectorAll('table').forEach(table => {
      if (table.parentElement.classList.contains('table-scroll')) return
      const wrapper = document.createElement('div')
      wrapper.className = 'table-scroll'
      table.parentNode.insertBefore(wrapper, table)
      wrapper.appendChild(table)
    })
  }, [html, loading])

  if (loading) return <p className="loading">Loading…</p>
  if (error) return <p className="error">{error}</p>

  return (
    <div className="viewer-content">
      <article ref={articleRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
