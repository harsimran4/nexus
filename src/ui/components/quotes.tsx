import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Page quotes — one quiet serif line per section, picked fresh each visit.
// ---------------------------------------------------------------------------

const QUOTES: Record<string, { text: string; by: string }[]> = {
  board: [
    { text: 'Plans are worthless, but planning is everything.', by: 'Dwight D. Eisenhower' },
    { text: 'The secret of getting ahead is getting started.', by: 'Mark Twain' },
    { text: 'Vision without execution is just hallucination.', by: 'Thomas Edison' },
  ],
  groups: [
    { text: 'Out of clutter, find simplicity.', by: 'Albert Einstein' },
    { text: 'For every minute spent organizing, an hour is earned.', by: 'Benjamin Franklin' },
    { text: 'The ability to simplify means to eliminate the unnecessary.', by: 'Hans Hofmann' },
  ],
  scripts: [
    { text: 'The first draft is just you telling yourself the story.', by: 'Terry Pratchett' },
    { text: 'Get it down. Take chances. It may be bad, but it’s the only way you can do anything really good.', by: 'William Faulkner' },
    { text: 'You can’t wait for inspiration. You have to go after it with a club.', by: 'Jack London' },
  ],
  project: [
    { text: 'Cinema is truth twenty-four times per second.', by: 'Jean-Luc Godard' },
    { text: 'Art is never finished, only abandoned.', by: 'Leonardo da Vinci' },
    { text: 'Everything you can imagine is real.', by: 'Pablo Picasso' },
  ],
  archive: [
    { text: 'The past is never dead. It’s not even past.', by: 'William Faulkner' },
    { text: 'Those who cannot remember the past are condemned to repeat it.', by: 'George Santayana' },
    { text: 'Real museums are places where time is transformed into space.', by: 'Orhan Pamuk' },
  ],
  login: [
    { text: 'The way to get started is to quit talking and begin doing.', by: 'Walt Disney' },
    { text: 'Every artist was first an amateur.', by: 'Ralph Waldo Emerson' },
    { text: 'Start where you are. Use what you have. Do what you can.', by: 'Arthur Ashe' },
  ],
  admin: [
    { text: 'Authority without wisdom is like a heavy axe without an edge.', by: 'Anne Bradstreet' },
    { text: 'To be trusted is a greater compliment than to be loved.', by: 'George MacDonald' },
    { text: 'The price of greatness is responsibility.', by: 'Winston Churchill' },
  ],
  activity: [
    { text: 'History is a set of lies agreed upon.', by: 'Napoleon Bonaparte' },
    { text: 'Study the past if you would define the future.', by: 'Confucius' },
    { text: 'The past is a foreign country; they do things differently there.', by: 'L.P. Hartley' },
  ],
  setup: [
    { text: 'The beginning is the most important part of the work.', by: 'Plato' },
    { text: 'Every new beginning comes from some other beginning’s end.', by: 'Seneca' },
    { text: 'Well begun is half done.', by: 'Aristotle' },
  ],
}

export type QuoteTopic = keyof typeof QUOTES

export function PageQuote({ topic }: { topic: QuoteTopic }): ReactNode {
  const pool = QUOTES[topic]
  if (!pool || pool.length === 0) return null
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return (
    <div className="page-quote">
      <span className="q">{pick.text}</span>
      <span className="by">— {pick.by}</span>
    </div>
  )
}
