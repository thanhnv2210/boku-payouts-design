import { marked } from 'marked'

export function renderMarkdown(content) {
  return marked.parse(content)
}

// PlantUML encoding — deflate-raw compressed, then PlantUML's base64 variant
function encode6bit(b) {
  if (b < 10) return String.fromCharCode(48 + b)
  b -= 10
  if (b < 26) return String.fromCharCode(65 + b)
  b -= 26
  if (b < 26) return String.fromCharCode(97 + b)
  b -= 26
  if (b === 0) return '-'
  if (b === 1) return '_'
  return '?'
}

function append3bytes(b1, b2, b3) {
  return (
    encode6bit((b1 >> 2) & 0x3F) +
    encode6bit(((b1 & 0x3) << 4) | ((b2 >> 4) & 0xF)) +
    encode6bit(((b2 & 0xF) << 2) | ((b3 >> 6) & 0x3)) +
    encode6bit(b3 & 0x3F)
  )
}

function plantUMLBase64(bytes) {
  let r = ''
  for (let i = 0; i < bytes.length; i += 3) {
    r += append3bytes(bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0)
  }
  return r
}

export async function encodePlantUML(text) {
  const data = new TextEncoder().encode(text)
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  writer.write(data)
  writer.close()
  const chunks = []
  const reader = cs.readable.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const compressed = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) { compressed.set(chunk, offset); offset += chunk.length }
  return plantUMLBase64(compressed)
}

export function getPlantUMLUrl(encoded, format = 'svg') {
  return `https://www.plantuml.com/plantuml/${format}/${encoded}`
}
