const fs = require('fs')
const j = JSON.parse(fs.readFileSync('C:/Users/HARSIM~1/AppData/Local/Temp/claude/c--Users-Harsimran-Desktop-projects-ContentManagement-Nexus/88a0181f-0038-4561-8825-21afcdaa246e/tasks/wpvxet5zc.output', 'utf8'))
const r = j.result ?? j
const short = (p) => p.replace(/^.*?[\\/]src/, 'src').replace(/^.*?Nexus[\\/]/, '')
console.log('=== CONFIRMED (' + r.confirmed.length + '):')
for (const f of r.confirmed) {
  console.log('\n[' + f.severity + '] ' + short(f.file) + (f.line ? ':' + f.line : '') + ' — ' + f.title)
  console.log('  CLAIM: ' + f.claim.slice(0, 340).replace(/\n/g, ' '))
  const hints = (f.votes || []).filter((v) => v.fix_hint).map((v) => v.fix_hint)
  if (hints.length) console.log('  FIX: ' + hints[0].slice(0, 480).replace(/\n/g, ' '))
}
console.log('\n=== REFUTED/UNVERIFIED (' + (r.refuted || []).length + '):')
for (const x of r.refuted || []) console.log('  - [' + (x.why ? 'refuted' : 'UNVERIFIED(429)') + '] ' + short(x.file) + ' — ' + x.title.slice(0, 130))
console.log('\n=== LOWS (' + (r.lows || []).length + '):')
for (const l of r.lows || []) console.log('  - ' + short(l.file) + ' — ' + l.title.slice(0, 140) + ' :: ' + l.claim.slice(0, 200).replace(/\n/g, ' '))
