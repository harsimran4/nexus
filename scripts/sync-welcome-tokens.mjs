// Single source of truth for design tokens: src/ui/tokens.css is THE palette;
// this script copies it verbatim to public/welcome-tokens.css so welcome.html
// links the same values the app compiles (it used to duplicate them by hand
// and drift). Runs before every build.
//   node scripts/sync-welcome-tokens.mjs

import fs from 'node:fs'

const src = fs.readFileSync('src/ui/tokens.css', 'utf8')
const banner =
  `/* GENERATED — do not edit. Copied from src/ui/tokens.css by\n` +
  `   scripts/sync-welcome-tokens.mjs; run the build to refresh. */\n\n`
fs.writeFileSync('public/welcome-tokens.css', banner + src)
console.log('welcome-tokens.css synced from src/ui/tokens.css')
