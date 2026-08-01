export async function loadIndex() {
  const res = await fetch('/docs/index.json')
  if (!res.ok) throw new Error('Failed to load document index')
  const data = await res.json()
  return data.tree
}

export async function loadDocument(path) {
  const res = await fetch(`/${path}`)
  if (!res.ok) throw new Error(`Failed to load: ${path}`)
  return res.text()
}

export function collectDocs(nodes) {
  const docs = []
  for (const node of nodes) {
    if (node.children) docs.push(...collectDocs(node.children))
    else docs.push(node)
  }
  return docs
}

export function findDocById(nodes, id) {
  for (const node of nodes) {
    if (node.children) {
      const found = findDocById(node.children, id)
      if (found) return found
    } else if (node.id === id) {
      return node
    }
  }
  return null
}
