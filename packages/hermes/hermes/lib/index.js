// Hermes memory + skill learning for the DeepSeek Harness.
//
// Persistence has two tiers:
//   - GLOBAL (default): agent notes / user profile / skills persist through
//     the host settings service (~/.dsh/settings.yaml, key hermes-memory).
//   - PROJECT: memory target "project" writes <workspaceRoot>/.hermes/memory.json;
//     skill_manage scope "project" writes <workspaceRoot>/.dsh/skills/<name>.md
//     (auto-discovered by skill-filesystem for sessions of that workspace).
// The workspace root is resolved per tool call from the calling agent's
// session cwd (nearest .git root, overridable with the "project" argument).
//
// This file is referenced by absolute path from a user agent preset. It is
// hand-written ESM (no TypeScript build) and imports schemastery through a
// relative path to the vendored source so it needs no pnpm install.
//
// v2 (2026-08-29): implemented the documented-but-missing PROJECT tier;
// rebalanced the system prompt (skills now get an always-on block with the
// live skill list and a patch-don't-stale reminder); surfaced live
// registration failures instead of swallowing them; raised memory limits
// (the old 4000-char cap was already exceeded by real usage, which made
// every memory add fail at the limit check).

import fs from 'node:fs'
import path from 'node:path'
import z from '../../../../vendor/schemastery/lib/index.mjs'

export const name = 'hermes'
export const inject = ['tools', 'systemPrompt']

const NL = String.fromCharCode(10)
const MEMORY_LIMIT = 8000 // ~3000 tokens — agent's personal notes
const USER_LIMIT = 3000 // ~1100 tokens — user profile
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const schema = z.object({
  memory: z.array(z.string()),
  user: z.array(z.string()),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    content: z.string(),
  })),
})

function fail(error, extra) { return JSON.stringify(Object.assign({ success: false, error }, extra)) }
function done(extra) { return JSON.stringify(Object.assign({ success: true }, extra)) }

// ── project skill file I/O (frontmatter: name + quoted description) ──

function parseSkillFile(text) {
  const lines = text.split(NL).map((l) => l.split(String.fromCharCode(13)).join(''))
  if (lines[0] !== '---') return { name: '', description: '', body: text }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { end = i; break }
  }
  if (end === -1) return { name: '', description: '', body: text }
  let name = ''
  let description = ''
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    if (name === '' && line.startsWith('name:')) name = line.slice(5).trim()
    else if (description === '' && line.startsWith('description:')) description = line.slice(12).trim()
  }
  if (description.length >= 2) {
    const q = description.charAt(0)
    if ((q === '"' || q === "'") && description.charAt(description.length - 1) === q) {
      description = description.slice(1, -1)
      if (q === "'") description = description.split("''").join("'")
    }
  }
  if (name.length >= 2) {
    const q = name.charAt(0)
    if ((q === '"' || q === "'") && name.charAt(name.length - 1) === q) name = name.slice(1, -1)
  }
  return { name, description, body: lines.slice(end + 1).join(NL) }
}

function renderSkillFile(name, description, body) {
  const desc = String(description || '').replace(/'/g, "''")
  return '---' + NL + 'name: ' + name + NL + "description: '" + desc + "'" + NL + '---' + NL + NL + body
}

export function apply(ctx, config) {
  const settings = ctx.get('settings')
  const skills = ctx.get('skills')

  // Live view. Falls back to in-memory when the settings service is absent.
  let scope
  const live = { memory: [], user: [], skills: [] }
  const disposers = new Map()

  if (settings !== undefined) {
    try {
      scope = settings.register('hermes-memory', schema, { base: { memory: [], user: [], skills: [] } })
      const resolved = scope.get()
      if (Array.isArray(resolved.memory)) live.memory = resolved.memory.filter((x) => typeof x === 'string')
      if (Array.isArray(resolved.user)) live.user = resolved.user.filter((x) => typeof x === 'string')
      if (Array.isArray(resolved.skills)) {
        for (const s of resolved.skills) {
          if (s && typeof s.name === 'string' && NAME_RE.test(s.name) && typeof s.content === 'string') {
            live.skills.push({ name: s.name, description: typeof s.description === 'string' ? s.description : '', content: s.content })
          }
        }
      }
    } catch (error) {
      scope = undefined
    }
  }

  async function persistMemory(memory, user) {
    if (scope === undefined) throw new Error('settings service unavailable; memory is not persisted')
    await scope.update({ memory, user })
  }

  async function persistSkills(skillsArr) {
    if (scope === undefined) throw new Error('settings service unavailable; skills are not persisted')
    await scope.update({ skills: skillsArr.map((s) => ({ name: s.name, description: s.description, content: s.content })) })
  }

  // Returns true when the skill is also live in this session's catalog.
  function registerSkill(entry) {
    if (skills === undefined) return false
    try {
      disposers.set(entry.name, skills.register({
        name: entry.name,
        description: entry.description,
        source: 'custom',
        content: entry.content,
      }))
      return true
    } catch (_) {
      // duplicate or invalid name: kept in settings, not live this session
      return false
    }
  }

  function disposeSkill(name) {
    const old = disposers.get(name)
    if (typeof old === 'function') { try { old() } catch (_) { /* already disposed */ } disposers.delete(name) }
  }

  // ── project root / project files ──

  function resolveProjectRoot(args, exec) {
    if (args && typeof args.project === 'string' && args.project.trim() !== '') return path.resolve(args.project.trim())
    let cwd
    try { cwd = exec.agent.session.header.cwd } catch (_) { cwd = undefined }
    if (typeof cwd !== 'string' || cwd === '') return undefined
    let dir = path.resolve(cwd)
    for (let i = 0; i < 24; i += 1) {
      try { if (fs.existsSync(path.join(dir, '.git'))) return dir } catch (_) { /* keep walking */ }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return path.resolve(cwd)
  }

  function projectMemoryFile(root) { return path.join(root, '.hermes', 'memory.json') }
  function projectSkillsDir(root) { return path.join(root, '.dsh', 'skills') }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  }

  function readProjectMemory(root) {
    const data = readJson(projectMemoryFile(root), {})
    return Array.isArray(data.memory) ? data.memory.filter((x) => typeof x === 'string') : []
  }

  function listProjectSkills(root) {
    const dir = projectSkillsDir(root)
    let names
    try { names = fs.readdirSync(dir) } catch (_) { return [] }
    const out = []
    for (const f of names) {
      if (!f.endsWith('.md')) continue
      const file = path.join(dir, f)
      try {
        const parsed = parseSkillFile(fs.readFileSync(file, 'utf8'))
        out.push({ name: parsed.name || f.replace(/\.md$/, ''), description: parsed.description, content: parsed.body, file })
      } catch (_) { /* unreadable file: skip */ }
    }
    return out
  }

  // ── system prompt section ──

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'hermes:memory',
    order: 90,
    text: () => {
      const mem = live.memory.filter(Boolean)
      const user = live.user.filter(Boolean)
      const parts = []
      parts.push('AUTOMATIC MEMORY (always on): you maintain this memory yourself, proactively — never wait to be asked. After each turn, if the user expressed a preference, revealed a working style, corrected you, or stated a convention, save it now with the "memory" tool. After finishing a task together, summarize the preferences you observed into compact entries. Prefer target "user" for preferences/communication style; target "memory" for environment/project facts and learned techniques; target "project" for notes that only matter inside the current workspace. Forgetting costs repeated corrections; saving is cheap and permanent.')
      if (mem.length > 0) {
        parts.push('════════════ MEMORY (your personal notes) ════════════' + NL + mem.join(NL + '§' + NL))
      }
      if (user.length > 0) {
        parts.push('════════════ USER PROFILE ════════════' + NL + user.join(NL + '§' + NL))
      }
      let skillBlock = 'SKILL LEARNING (always on): skills are your reusable procedures — author them, and keep them alive.' + NL
        + '- Finished a non-trivial workflow (5+ tool calls, or any multi-step task you would not want to redo from scratch)? Distill the working path into a skill this turn with "skill_manage create". Procedures belong in skills; memory is for facts, landmines, and preferences.' + NL
        + '- Learned something that refines a workflow an existing skill already covers? Patch THAT skill now ("skill_manage patch") — an unpatched skill goes stale and will mislead every future session that loads it.' + NL
        + '- Before creating, check the list below: patch the closest skill instead of creating a near-duplicate. Global skills persist for every project; pass scope "project" to store a skill inside the workspace (.dsh/skills/), and memory target "project" for workspace-scoped notes.'
      const skillLines = live.skills.map((s) => '- ' + s.name + (s.description ? ' — ' + s.description : ''))
      if (skillLines.length > 0) skillBlock += NL + NL + 'Your skills:' + NL + skillLines.join(NL)
      parts.push(skillBlock)
      parts.push('Recall past sessions with "session_search".')
      return parts.join(NL + NL)
    },
  }))

  // ── memory tool (targets: memory | user | project) ──

  ctx.effect(() => ctx.tools.register({
    name: 'memory',
    description: 'Persistent cross-session memory (agent notes + user profile + per-project notes), injected into your prompt every session. Call this proactively whenever you observe a preference or finish a task — do not wait to be asked. Actions: list, add, replace, remove. Store compact, information-dense facts only — user preferences, environment facts, project conventions, corrections, completed work. Skip trivia, re-discoverable facts, raw data dumps, and one-off ephemera.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | add | replace | remove' },
        target: { type: 'string', description: 'memory (agent notes), user (user profile), or project (workspace notes in .hermes/memory.json); defaults to memory' },
        content: { type: 'string', description: 'new entry text (add / replace)' },
        old_text: { type: 'string', description: 'unique substring identifying one existing entry (replace / remove)' },
        project: { type: 'string', description: 'workspace path override for the project tier (defaults to the nearest .git root above the session cwd)' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args, exec) => {
      const action = args.action || 'list'
      const target = args.target === 'user' ? 'user' : args.target === 'project' ? 'project' : 'memory'

      let list
      let limit
      let persist
      let label
      if (target === 'project') {
        const root = resolveProjectRoot(args, exec)
        if (root === undefined) return fail('cannot resolve the session workspace for project memory; pass an explicit project path')
        const file = projectMemoryFile(root)
        list = readProjectMemory(root)
        limit = MEMORY_LIMIT
        persist = async (next) => { writeJson(file, { memory: next }) }
        label = 'project:' + file
      } else {
        list = target === 'user' ? live.user : live.memory
        limit = target === 'user' ? USER_LIMIT : MEMORY_LIMIT
        persist = async (next) => { await persistMemory(target === 'user' ? live.memory : next, target === 'user' ? next : live.user) }
        label = target
      }
      const joined = () => list.join(NL)
      const usage = () => joined().length + '/' + limit + ' (' + label + ')'

      if (action === 'list') {
        return JSON.stringify({ success: true, target, entries: list.slice(), usage: usage() })
      }

      if (action === 'add') {
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (content === '') return fail('content is required for add')
        if (list.indexOf(content) !== -1) return done({ note: 'no duplicate added', usage: usage() })
        if (joined().length + content.length > limit) {
          return fail('memory at ' + usage() + '; adding would exceed the limit. Consolidate with replace/remove first, then retry add.', { current_entries: list.slice() })
        }
        const next = list.slice()
        next.push(content)
        try { await persist(next) } catch (e) { return fail('persist failed: ' + String(e && e.message ? e.message : e)) }
        list.push(content)
        return done({ target, added: content, usage: usage() })
      }

      if (action === 'replace' || action === 'remove') {
        const oldText = typeof args.old_text === 'string' ? args.old_text : ''
        if (oldText === '') return fail('old_text is required for ' + action)
        const matches = []
        for (let i = 0; i < list.length; i += 1) if (list[i].indexOf(oldText) !== -1) matches.push(i)
        if (matches.length === 0) return fail('no entry contains old_text "' + oldText + '"')
        if (matches.length > 1) return fail('old_text matches ' + matches.length + ' entries; provide a more specific substring')

        const idx = matches[0]
        if (action === 'remove') {
          const next = list.slice()
          const removed = next.splice(idx, 1)[0]
          try { await persist(next) } catch (e) { return fail('persist failed: ' + String(e && e.message ? e.message : e)) }
          list.splice(idx, 1)
          return done({ target, removed, usage: usage() })
        }

        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (content === '') return fail('content is required for replace')
        const after = list.slice()
        after[idx] = content
        if (after.join(NL).length > limit) {
          return fail('replacement would exceed the ' + limit + '-char limit; shorten content or remove another entry', { current_entries: list.slice() })
        }
        const before = list[idx]
        const next = list.slice()
        next[idx] = content
        try { await persist(next) } catch (e) { return fail('persist failed: ' + String(e && e.message ? e.message : e)) }
        list[idx] = content
        return done({ target, replaced: before, with: content, usage: usage() })
      }

      return fail('unknown action "' + action + '"')
    },
  }))

  // ── skill_manage tool (scopes: global | project) ──

  ctx.effect(() => ctx.tools.register({
    name: 'skill_manage',
    description: 'Author, update and delete your own reusable skills (procedural memory), persisted user-globally or per-project. Create a skill after completing a non-trivial workflow (5+ tool calls), after hitting dead ends and finding the working path, or after a user corrects your approach. Patch an existing skill the moment new lessons refine it — stale skills mislead future sessions. "content" is the full SKILL.md-style markdown body with sections such as "When to Use", "Procedure", "Pitfalls", "Verification". Actions: create, patch, delete, list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'create | patch | delete | list' },
        scope: { type: 'string', description: 'global (default) persists in settings.yaml for every project; project writes <workspace>/.dsh/skills/<name>.md for sessions of that workspace' },
        name: { type: 'string', description: 'kebab-case skill name' },
        description: { type: 'string', description: 'one-line routing description (create); patch may pass it to rewrite the project frontmatter' },
        content: { type: 'string', description: 'full skill markdown body (create), or replacement text (patch)' },
        old_string: { type: 'string', description: 'exact substring to replace (patch)' },
        project: { type: 'string', description: 'workspace path override for the project tier (defaults to the nearest .git root above the session cwd)' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args, exec) => {
      const action = args.action || 'list'
      const scope = args.scope === 'project' ? 'project' : 'global'
      const name = typeof args.name === 'string' ? args.name : ''

      if (action === 'list') {
        const result = live.skills.map((s) => ({ scope: 'global', name: s.name, description: s.description }))
        const root = resolveProjectRoot(args, exec)
        if (root !== undefined) {
          for (const s of listProjectSkills(root)) {
            result.push({ scope: 'project', name: s.name, description: s.description, file: s.file })
          }
        }
        return JSON.stringify({ success: true, skills: result }, null, 2)
      }

      if (!NAME_RE.test(name)) return fail('name must be kebab-case: [a-z0-9]+(-[a-z0-9]+)*')

      if (scope === 'project') {
        const root = resolveProjectRoot(args, exec)
        if (root === undefined) return fail('cannot resolve the session workspace; pass scope "global" or an explicit project path')
        const dir = projectSkillsDir(root)
        const file = path.join(dir, name + '.md')
        if (action === 'create') {
          const content = typeof args.content === 'string' ? args.content : ''
          if (content.trim() === '') return fail('content is required for create')
          if (fs.existsSync(file)) return fail('project skill "' + name + '" already exists at ' + file + '; use patch or delete first')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(file, renderSkillFile(name, typeof args.description === 'string' ? args.description : '', content), 'utf8')
          return done({ created: name, scope: 'project', file, note: 'the live catalog picks project skills up for sessions of this workspace (skill-filesystem discovery)' })
        }
        if (action === 'patch') {
          if (!fs.existsSync(file)) return fail('no project skill "' + name + '" at ' + file)
          let parsed
          try { parsed = parseSkillFile(fs.readFileSync(file, 'utf8')) } catch (e) { return fail('cannot read ' + file + ': ' + String(e && e.message ? e.message : e)) }
          const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
          if (oldStr === '') return fail('old_string is required for patch')
          if (parsed.body.indexOf(oldStr) === -1) return fail('old_string not found in project skill "' + name + '"')
          const body = parsed.body.replace(oldStr, typeof args.content === 'string' ? args.content : '')
          const description = typeof args.description === 'string' && args.description.trim() !== '' ? args.description.trim() : parsed.description
          fs.writeFileSync(file, renderSkillFile(name, description, body), 'utf8')
          return done({ patched: name, scope: 'project', file })
        }
        if (action === 'delete') {
          if (!fs.existsSync(file)) return fail('no project skill "' + name + '" at ' + file)
          fs.unlinkSync(file)
          return done({ deleted: name, scope: 'project', file })
        }
        return fail('unknown action "' + action + '"')
      }

      if (action === 'create') {
        const content = typeof args.content === 'string' ? args.content : ''
        if (content.trim() === '') return fail('content is required for create')
        if (live.skills.some((s) => s.name === name)) return fail('skill "' + name + '" already exists; use patch or delete first')
        const entry = { name, description: typeof args.description === 'string' ? args.description : '', content }
        const next = live.skills.slice()
        next.push(entry)
        try { await persistSkills(next) } catch (e) { return fail('persist failed: ' + String(e && e.message ? e.message : e)) }
        live.skills.push(entry)
        const liveOk = registerSkill(entry)
        return done(liveOk ? { created: name } : { created: name, note: 'persisted, but live registration failed — the skill appears in the catalog next session' })
      }

      if (action === 'patch') {
        const entry = live.skills.find((s) => s.name === name)
        if (entry === undefined) return fail('no skill "' + name + '"')
        const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
        if (oldStr === '') return fail('old_string is required for patch')
        if (entry.content.indexOf(oldStr) === -1) return fail('old_string not found in skill "' + name + '"')
        const newContent = entry.content.replace(oldStr, typeof args.content === 'string' ? args.content : '')
        const next = live.skills.map((s) => s === entry ? { name: s.name, description: s.description, content: newContent } : s)
        try { await persistSkills(next) } catch (e) { return fail('persist failed: ' + String(e && e.message ? e.message : e)) }
        entry.content = newContent
        disposeSkill(name)
        const liveOk = registerSkill(entry)
        return done(liveOk ? { patched: name } : { patched: name, note: 'persisted, but live re-registration failed — the catalog refreshes next session' })
      }

      if (action === 'delete') {
        const idx = live.skills.findIndex((s) => s.name === name)
        if (idx === -1) return fail('no skill "' + name + '"')
        const next = live.skills.filter((s, i) => i !== idx)
        try { await persistSkills(next) } catch (e) { return fail('persist failed: ' + String(e && e.message ? e.message : e)) }
        live.skills.splice(idx, 1)
        disposeSkill(name)
        return done({ deleted: name })
      }

      return fail('unknown action "' + action + '"')
    },
  }))
}
