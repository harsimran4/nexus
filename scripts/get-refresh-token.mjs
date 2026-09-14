// One-time: mint the Google OAuth refresh token the write relay uses to act
// as the studio account. Run from the project root:
//
//   node scripts/get-refresh-token.mjs
//
// Before running (Google Cloud Console → APIs & Services → Credentials → your
// OAuth client):
//   1. Copy the client SECRET (it will be requested when the script runs).
//   2. Add http://localhost:8899/ to "Authorized redirect URIs".
//
// Sign in with the STUDIO Google account (the one that owns the workspace),
// approve, and the script prints GOOGLE_REFRESH_TOKEN for Deno Deploy.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const PORT = 8899
const REDIRECT = `http://localhost:${PORT}/`
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

function readEnvLocal() {
  try {
    const raw = readFileSync('.env.local', 'utf8')
    const out = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(VITE_[A-Z_]+)=(.*)\s*$/)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  } catch {
    return {}
  }
}

const env = readEnvLocal()
const clientId = env.VITE_NEXUS_CLIENT_ID
if (!clientId) {
  console.error('VITE_NEXUS_CLIENT_ID not found in .env.local')
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const clientSecret = (await rl.question('Paste the OAuth client SECRET: ')).trim()
rl.close()
if (!clientSecret) {
  console.error('Client secret is required')
  process.exit(1)
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  })

const codePromise = new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, REDIRECT)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<h2 style="font-family:system-ui">Token request received — you can close this tab.</h2>')
    const code = url.searchParams.get('code')
    server.close()
    if (code) resolve(code)
    else reject(new Error('No code in redirect: ' + req.url))
  }).listen(PORT)
  setTimeout(() => reject(new Error('Timed out waiting for the Google redirect')), 300_000)
})

console.log('Opening Google consent in your browser…')
console.log('(If nothing opens, copy-paste this URL manually — it is long, take ALL of it):\n' + authUrl + '\n')
// rundll32 passes the URL to the default browser without a shell in between —
// `cmd /c start` splits the URL at every `&` (Google's error 400:
// "response_type missing" was exactly that).
spawn('rundll32', ['url.dll,FileProtocolHandler', authUrl], { stdio: 'ignore', shell: false }).unref()

const code = await codePromise

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
  }),
})
const token = await res.json()
if (!token.refresh_token) {
  console.error('No refresh_token in the response — re-run and make sure "prompt=consent" was approved.', token)
  process.exit(1)
}

console.log('\nSet these in Deno Deploy → your relay project → Settings → Environment variables:\n')
console.log('GOOGLE_CLIENT_ID=' + clientId)
console.log('GOOGLE_CLIENT_SECRET=' + clientSecret)
console.log('GOOGLE_REFRESH_TOKEN=' + token.refresh_token)
console.log('NEXUS_FILE_ID=' + (env.VITE_NEXUS_FILE_ID ?? '(copy VITE_NEXUS_FILE_ID from .env.local)'))
console.log('TICKET_SECRET=' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''))
