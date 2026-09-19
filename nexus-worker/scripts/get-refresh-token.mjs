// One-time script: run this ONCE, signed in as the studio Google account,
// to mint a refresh token for the Worker. Never run it as anyone else —
// whoever's account you authenticate with here becomes the permanent
// storage owner for all of Nexus's files.
//
// Setup (Google Cloud Console, same project as your existing OAuth client):
//   APIs & Services -> Credentials -> Create credentials -> OAuth client ID
//   Application type: "Desktop app"
//   (Desktop apps are allowed to use a plain http://localhost redirect for
//   this kind of one-off script — no domain verification needed.)
//   Copy the client ID + client secret and paste them below or pass as env vars.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
//
// A browser tab opens -> sign in as the studio account -> approve -> this
// script prints the refresh token. Paste it into the Worker as a secret:
//   wrangler secret put GOOGLE_REFRESH_TOKEN

import http from 'node:http'
import { exec } from 'node:child_process'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'PASTE_CLIENT_ID_HERE'
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'PASTE_CLIENT_SECRET_HERE'
const PORT = 53682
const REDIRECT_URI = `http://127.0.0.1:${PORT}`
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} "${url}"`)
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent', // forces a refresh_token even on repeat runs
  }).toString()

console.log('\nOpening this URL — sign in as the STUDIO Google account:\n')
console.log(authUrl + '\n')
openBrowser(authUrl)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI)
  const code = url.searchParams.get('code')
  if (!code) {
    res.end('No code received — check the terminal and try again.')
    return
  }
  res.end('Success — you can close this tab and return to the terminal.')

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  const data = await tokenRes.json()
  if (data.refresh_token) {
    console.log('\n✅ Refresh token (paste this into `wrangler secret put GOOGLE_REFRESH_TOKEN`):\n')
    console.log(data.refresh_token)
    console.log('\nAlso set these two the same way:')
    console.log(`  GOOGLE_CLIENT_ID     = ${CLIENT_ID}`)
    console.log(`  GOOGLE_CLIENT_SECRET = ${CLIENT_SECRET}\n`)
  } else {
    console.error('\n❌ No refresh_token in response — did you already grant consent before? Response:', data)
    console.error('Fix: revoke prior access at https://myaccount.google.com/permissions and rerun this script.\n')
  }
  server.close()
  process.exit(0)
})

server.listen(PORT, () => console.log(`Waiting for the browser redirect on ${REDIRECT_URI} ...`))
