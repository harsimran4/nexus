// Read every D1 table back for the doc regeneration (the shadow gate's
// instrument). Small workspace → a handful of point SELECTs; activity is
// capped newest-first here so rowsToDoc's slice is already satisfied.

import type { AllRows } from './tables'

// D1 binding type comes from the ambient declarations in src/env.d.ts.

export async function readAllRows(db: D1Database): Promise<AllRows> {
  const activityCap = 1500 // = ACTIVITY_LOCAL_BUFFER — the doc's own cap
  // ONE batch = one subrequest (and one consistent snapshot) for all 20 reads
  // — the write-through runs this on every mutation.
  const activityStmt = db.prepare(`SELECT seq, at, actor, verb, ref, meta FROM activity ORDER BY seq DESC LIMIT ?`).bind(activityCap)
  const results = (await db.batch([
    activityStmt,
    db.prepare('SELECT key, value FROM meta'),
    db.prepare('SELECT * FROM groups'),
    db.prepare('SELECT * FROM projects'),
    db.prepare('SELECT * FROM media_sections'),
    db.prepare('SELECT * FROM project_files'),
    db.prepare('SELECT * FROM scripts'),
    db.prepare('SELECT * FROM script_acts'),
    db.prepare('SELECT * FROM script_copies'),
    db.prepare('SELECT * FROM beats'),
    db.prepare('SELECT * FROM scenes'),
    db.prepare('SELECT * FROM shots'),
    db.prepare('SELECT * FROM story_links'),
    db.prepare('SELECT * FROM users_app'),
    db.prepare('SELECT * FROM viewers'),
    db.prepare('SELECT * FROM upload_links'),
    db.prepare('SELECT * FROM refs'),
    db.prepare('SELECT * FROM comments'),
    db.prepare('SELECT * FROM deletions'),
    db.prepare('SELECT * FROM snapshots'),
  ])) as { results: Record<string, unknown>[] }[]
  const [activityRes, meta, groups, projects, sections, files, scripts, scriptActs, copies, beats, scenes, shots, storyLinks, users, viewers, links, refs, comments, deletions, snapshots] = results

  return {
    meta: meta.results,
    groups: groups.results,
    projects: projects.results,
    media_sections: sections.results,
    project_files: files.results,
    scripts: scripts.results,
    script_acts: scriptActs.results,
    script_copies: copies.results,
    beats: beats.results,
    scenes: scenes.results,
    shots: shots.results,
    story_links: storyLinks.results,
    users_app: users.results,
    viewers: viewers.results,
    upload_links: links.results,
    refs: refs.results,
    comments: comments.results,
    activity: activityRes.results,
    deletions: deletions.results,
    snapshots: snapshots.results,
  } as unknown as AllRows // boundary cast: D1 returns the schema's own column types
}
