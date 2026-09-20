// Tiny dependency-free markdown renderer for script previews. Supports
// #/##/### headings, **bold**, *italic*, `code`, ``` fences, -/* bullets,
// 1. numbered lists and blank-line paragraphs. Everything is HTML-escaped
// BEFORE transforms, so a script can't inject markup into the preview.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function renderMarkdown(md: string): string {
  const lines = esc(md).split(/\r?\n/)
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let inFence = false
  let fence: string[] = []
  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```/)
    if (fenceMatch) {
      if (inFence) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`)
        inFence = false
        fence = []
      } else {
        closeList()
        inFence = true
        fence = []
      }
      continue
    }
    if (inFence) {
      fence.push(line)
      continue
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length + 2 // # → h3 … ### → h5 inside the preview
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    if (ul) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      continue
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ol) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ol[1])}</li>`)
      continue
    }
    closeList()
    if (!line.trim()) continue
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inFence && fence.length) out.push(`<pre><code>${fence.join('\n')}</code></pre>`)
  closeList()
  return out.join('\n')
}
