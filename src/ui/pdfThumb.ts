// PDF first-page renderer for thumbnails. pdf.js is BIG (~300KB gz with the
// worker) and only needed when a grid actually contains a PDF — so it is
// dynamically imported exactly once, on the first pdf thumb request. The
// worker rides a Vite ?url import (emitted as an asset, not inlined).

let loader: Promise<{ render: (src: string) => Promise<Blob | null> } | null> | null = null

async function load(): Promise<{ render: (src: string) => Promise<Blob | null> } | null> {
  if (!loader) {
    loader = (async () => {
      try {
        const [pdfjs, { default: workerUrl }] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ])
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        return {
          async render(src: string): Promise<Blob | null> {
            const task = pdfjs.getDocument({ url: src })
            const doc = await task.promise
            try {
              const page = await doc.getPage(1)
              const base = page.getViewport({ scale: 1 })
              const scale = Math.min(1, 480 / base.width)
              const vp = page.getViewport({ scale })
              const canvas = document.createElement('canvas')
              canvas.width = Math.max(2, Math.round(vp.width))
              canvas.height = Math.max(2, Math.round(vp.height))
              const ctx = canvas.getContext('2d')
              if (!ctx) return null
              await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
              return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
            } finally {
              await task.destroy()
            }
          },
        }
      } catch {
        return null // pdf.js failed to load — glyph tiles remain the answer
      }
    })()
  }
  return loader
}

/** Page 1 as a JPEG blob, or null when pdf.js couldn't do it. */
export async function renderPdfFirstPage(src: string): Promise<Blob | null> {
  const mod = await load()
  if (!mod) return null
  try {
    return await mod.render(src)
  } catch {
    return null
  }
}
