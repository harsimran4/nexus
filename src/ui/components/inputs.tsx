import { useState } from 'react'

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        setDone(true)
        setTimeout(() => setDone(false), 1600)
      }}
    >
      {done ? '✓ Copied' : label}
    </button>
  )
}

function EyeIcon({ off }: { off?: boolean }): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <path d="m2 2 20 20" />
        </>
      ) : (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

/** Password/token input masked by default, with an eye button to reveal what's typed. */
export function SecretInput({ className = 'input', ...rest }: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <div className="pw-wrap">
      <input {...rest} type={show ? 'text' : 'password'} className={className} spellCheck={false} />
      <button
        type="button"
        className="pw-eye"
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide' : 'Show'}
        aria-label={show ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        <EyeIcon off={show} />
      </button>
    </div>
  )
}

/** Show-once reveal for minted tokens — the raw secret never appears again. */
export function TokenReveal({ raw, kind, link }: { raw: string; kind: 'token' | 'password'; link?: string }) {
  return (
    <div>
      <p className="muted small">
        {kind === 'token'
          ? 'This access token is shown ONCE — copy it now. Only its hash is stored, it cannot be recovered later.'
          : 'Password set. Share it through a safe channel — only its hash is stored.'}
      </p>
      <div className="token-box">{raw}</div>
      <div className="row mt8">
        <CopyButton text={raw} label="Copy secret" />
        {link && <CopyButton text={link} label="Copy login link" />}
      </div>
      {link && (
        <p className="faint small mt8" style={{ wordBreak: 'break-all' }}>{link}</p>
      )}
    </div>
  )
}
