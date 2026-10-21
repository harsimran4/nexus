// ⌘K command palette — jump to any project/group/script, open a page, toggle
// the theme. Roving-focus listbox semantics (ArrowUp/Down/Home/End, Enter),
// Escape and backdrop close. Filter is plain substring scoring: the
// workspace's search is client-side by design (see the sync kernel), and at
// workspace scale a linear scan over a few hundred items is instant.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore } from '../../sync/store'
import { navigate } from '../../nav'
import { Icon } from './Icon'
import { useMaterialVariants } from './motion'

interface Item {
  id: string
  label: string
  hint: string
  icon: 'grid' | 'folder' | 'file-text' | 'sun' | 'box' | 'check'
  run: () => void
}

const PAGES: Item[] = [
  { id: 'page-board', label: 'Board', hint: 'page', icon: 'grid', run: () => navigate('/') },
  { id: 'page-groups', label: 'Groups', hint: 'page', icon: 'folder', run: () => navigate('/groups') },
  { id: 'page-scripts', label: 'Scripts', hint: 'page', icon: 'file-text', run: () => navigate('/scripts') },
  { id: 'page-archive', label: 'Archive', hint: 'page', icon: 'box', run: () => navigate('/archive') },
]

/** Subsequence match with a contiguous-prefix bonus — "clp" finds "Client
 *  PROject", "pro" ranks "Projects" above "Script for the project". */
function score(haystack: string, needle: string): number {
  if (!needle) return 1
  const h = haystack.toLowerCase()
  const idx = h.indexOf(needle)
  if (idx === 0) return 100 - h.length
  if (idx > 0) return 60 - idx - h.length * 0.1
  // subsequence fallback
  let hi = 0
  for (const ch of needle) {
    hi = h.indexOf(ch, hi)
    if (hi === -1) return -1
    hi++
  }
  return 20 - h.length
}

export function CommandPalette({ onToggleTheme }: { onToggleTheme: () => void }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const variants = useMaterialVariants('snappy')

  const toggle = (): void => {
    setOpen((o) => !o)
  }

  // Global ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [...PAGES]
    if (doc) {
      for (const p of Object.values(doc.projects)) {
        if (p.deleted !== null) continue
        list.push({
          id: `project-${p.id}`,
          label: p.name,
          hint: 'project',
          icon: 'grid',
          run: () => navigate(`/project/${p.id}`),
        })
      }
      for (const g of Object.values(doc.groups)) {
        if (g.deleted !== null) continue
        list.push({ id: `group-${g.id}`, label: g.name, hint: 'group', icon: 'folder', run: () => navigate(`/group/${g.id}`) })
      }
      for (const s of Object.values(doc.scripts)) {
        if (s.deleted !== null) continue
        list.push({
          id: `script-${s.id}`,
          label: s.title,
          hint: 'script',
          icon: 'file-text',
          run: () => navigate(`/scripts/${s.id}`),
        })
      }
    }
    list.push({ id: 'action-theme', label: 'Toggle light/dark theme', hint: 'action', icon: 'sun', run: onToggleTheme })
    return list
  }, [doc, onToggleTheme])

  const filtered = useMemo(() => {
    const scored = items
      .map((it) => ({ it, s: score(it.label, query.trim()) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
    return scored.map((x) => x.it)
  }, [items, query])

  // Reset per open + keep the selection in range.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // Focus after the materialize animation mounts the input.
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    }
  }, [open])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const runItem = (it: Item): void => {
    setOpen(false)
    it.run()
  }

  const onInputKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Home' && filtered.length) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End' && filtered.length) {
      e.preventDefault()
      setActive(filtered.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[active]
      if (it) runItem(it)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const ICONS = { grid: 'grid', folder: 'folder', 'file-text': 'file-text', sun: 'sun', box: 'box', check: 'check' } as const

  return (
    <>
      <button
        className="icon-btn"
        title="Command palette (Ctrl+K)"
        aria-label="Open command palette"
        onClick={toggle}
      >
        <Icon name="search" size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmdk-veil"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={variants.transition}
            onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
          >
            <motion.div
              className="cmdk"
              role="dialog"
              aria-modal="true"
              aria-label="Command palette"
              variants={variants.variants}
              initial="hidden"
              animate="shown"
              exit="exit"
              transition={variants.transition}
              style={{ transformOrigin: 'top center' }}
            >
              <input
                ref={inputRef}
                className="cmdk-input"
                placeholder="Jump to a project, group, script…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                role="combobox"
                aria-expanded
                aria-controls="cmdk-listbox"
                aria-activedescendant={filtered[active] ? `cmdk-opt-${filtered[active].id}` : undefined}
              />
              <div className="cmdk-list" id="cmdk-listbox" role="listbox" ref={listRef}>
                {filtered.length === 0 && <div className="cmdk-empty">Nothing matches “{query}”.</div>}
                {filtered.map((it, idx) => (
                  <button
                    key={it.id}
                    id={`cmdk-opt-${it.id}`}
                    role="option"
                    aria-selected={idx === active}
                    data-idx={idx}
                    className="cmdk-item"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => runItem(it)}
                  >
                    <Icon name={ICONS[it.icon]} size={14} />
                    <span>{it.label}</span>
                    <span className="cmdk-hint">{it.hint}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
