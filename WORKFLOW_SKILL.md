# 🎯 PROJECT WORKFLOW SKILL
> Copy this file to every project root as `WORKFLOW_SKILL.md`
> This defines the operating model for ALL projects from this point forward.
> Every Chat session, CC session, and Owner action follows this discipline.

---

## THE THREE ROLES

### 👤 OWNER (You)
- Describes what you want in plain language
- Makes all final decisions
- QAs the live result after every CC commit
- Reports back to Chat with screenshots or description
- Never writes code, never patches files manually
- Never acts as messenger between Chat and CC

### 🧠 CHAT (Claude Chat — this session)
- Reads the repo directly to understand current state
- Diagnoses problems before touching anything
- Prepares precise CC prompts with full context
- Reviews CC output and checks for regressions
- Updates project docs when needed
- Never writes directly to the repo
- Wakes up fresh each session by reading `masterseed.md` + `lessons_learned.md`

### 🤖 CC (Claude Code)
- Reads all relevant files fresh from repo before writing anything (L033)
- Writes complete replacement files — never patches (L074)
- Commits to GitHub with descriptive messages
- Moves completed prompt files to `docs/prompts/` and stamps ✅ COMPLETE
- Updates `masterseed.md` and `lessons_learned.md` after every fix
- Self-documents — never leaves the repo in an undocumented state

---

## THE LOOP (repeat forever)

```
Owner describes goal
       ↓
Chat reads repo → diagnoses → writes CC prompt → saves to docs/prompts/
       ↓
Owner pushes prompt file to repo (or Chat uploads it)
       ↓
Owner tells CC: "Read and execute: docs/prompts/CC_PROMPT_[name].md"
       ↓
CC reads masterseed + lessons_learned + all relevant source files
CC executes the task
CC commits files
CC moves prompt to docs/prompts/ stamped ✅ COMPLETE
CC updates masterseed.md + lessons_learned.md
       ↓
Owner QAs live result → reports back to Chat
       ↓
Chat checks repo if anything looks wrong → next prompt or done
```

---

## REPO FOLDER STRUCTURE (required for all projects)

```
/                          ← repo root (keep clean)
├── masterseed.md          ← project identity, current state, roadmap
├── lessons_learned.md     ← all lessons, rules, conventions
├── WORKFLOW_SKILL.md      ← this file
├── docs/
│   └── prompts/           ← all CC prompt files, stamped COMPLETE when done
├── src/                   ← frontend source (or equivalent)
└── [other project files]
```

**Root must stay clean** — only essential config files + the 3 doc files above.
No loose prompt files in root. No uploaded patches. No temp files.

---

## CC PROMPT FILE RULES

### Naming convention
`CC_PROMPT_[phase]_[description].md`
Examples:
- `CC_PROMPT_phase7a_grouped_positions.md`
- `CC_PROMPT_bugfix_portfolio_blackscreen.md`
- `CC_PROMPT_feature_bitcoin_tab.md`

### Where they live
- **Before execution:** repo root (so CC can find them easily)
- **After execution:** `docs/prompts/` stamped with `✅ COMPLETE` at the top

### CC must always do this after completing a prompt:
1. Move the prompt file from root → `docs/prompts/`
2. Add `✅ COMPLETE — [date] — [one line summary]` at the top of the file
3. Update `masterseed.md` — mark phase done, update broken state, update file inventory
4. Append new lessons to `lessons_learned.md` using next available L-number
5. Commit docs update separately: `docs: update masterseed and lessons_learned after [phase]`

---

## MASTERSEED.md STRUCTURE (required sections)

Every project's `masterseed.md` must have these sections:

```markdown
# 🌱 MASTERSEED — [Project Name]
> Last Updated: [date] — [one line summary of current state]

## PROJECT IDENTITY
[What it is, who it's for, the goal]

## OPERATING MODEL
[CC era model — same as this skill]

## STACK
[Tech stack table]

## DEPLOYMENT
[How to deploy each layer — critical rules]

## BUILD PHASES
[Table: phase, scope, status ✅/🔴/⬜]

## CURRENT STATE
[What is broken right now, what was just fixed]

## CONFIRMED WORKING (DO NOT BREAK)
[List of features that must survive every CC session]

## FILE INVENTORY
[Current folder structure with status per file]

## ROADMAP
[Prioritized next steps]

## CRITICAL RULES
[Project-specific rules CC must always follow]
```

---

## LESSONS_LEARNED.md STRUCTURE (required)

```markdown
# 📚 LESSONS LEARNED — [Project Name]
> CC reads this at the start of every session.

## HOW TO USE
[Brief instructions]

## PHASE [N] — [Name]

### L[NNN] — [Short title]
**Problem:** [What went wrong]
**Rule:** [What to do instead]
**Tag:** #category #phase
```

Rules for lessons:
- Sequential L-numbers across the entire project (L001, L002... L077...)
- Never delete old lessons — only add
- CC appends new lessons after every session
- Chat references lesson IDs in prompts (e.g. "follow L033, L075")

---

## CHAT SESSION STARTUP (every new chat)

When starting a new Chat session on any project:

**Owner says:**
> "Read masterseed.md and lessons_learned.md from [repo URL]. Then [describe what you want]."

**Chat does:**
1. Reads `masterseed.md` from repo via GitHub API
2. Reads `lessons_learned.md` from repo via GitHub API
3. Checks `docs/prompts/` for any recent completed prompts
4. Responds with current understanding + diagnosis + plan
5. Never asks owner to upload files — reads repo directly

---

## CC SESSION STARTUP (every CC session)

**Owner pastes this intro:**
```
New session. Ignore all previous context from other projects.

You are working on [Project Name] at [GitHub repo URL].

Before doing anything else, read:
- masterseed.md
- lessons_learned.md

Then read and execute: [prompt filename]
```

**CC does:**
1. Reads masterseed.md
2. Reads lessons_learned.md
3. Reads the prompt file
4. Reads all source files mentioned in the prompt — FRESH from repo
5. Executes the task
6. Commits, archives prompt, updates docs

---

## END OF CHAT SESSION DELIVERABLES

Every Chat session that involves a coding task must end with:

1. **Revised `masterseed.md`** — updated current state, phase status, roadmap
2. **Revised `lessons_learned.md`** — any new lessons from this session
3. **`CC_PROMPT_[name].md`** — next task ready for CC to execute

Owner uploads all 3 to repo root. CC picks up the prompt, executes, archives it, updates the docs. Next Chat session reads the updated docs and is instantly aligned.

---

## WHAT NEVER HAPPENS

| ❌ Never | ✅ Instead |
|---|---|
| Owner uploads source files to Chat | Chat reads from repo directly |
| Owner pastes error code into Chat | Owner sends screenshot, Chat diagnoses |
| Chat sends patches to Owner | CC writes complete replacement files |
| Owner manually edits source files | CC writes, commits, deploys |
| Chat guesses at file contents | Chat reads from repo before answering |
| CC writes based on stale context | CC reads fresh from repo every session |
| Prompt files pile up in repo root | CC archives to docs/prompts/ after execution |
| Lessons lost between sessions | CC appends to lessons_learned.md after every fix |
| Owner re-explains project history | masterseed.md + lessons_learned.md carry all context |

---

## TOKEN EFFICIENCY RULES

- Chat never asks for files the owner must upload — reads repo directly
- Chat references lesson IDs (L033) instead of re-explaining rules
- CC prompts include only what CC needs — no backstory padding
- masterseed.md is the single source of truth — never duplicate info in prompts
- One CC session handles all related changes — never one-fix-per-session for batches
- Chat keeps diagnosis concise — describe the problem + the fix, not the history

---

## QUICK REFERENCE — CC GOLDEN RULES

From `lessons_learned.md` — CC must follow these in every session:

| Rule | Lesson | Description |
|---|---|---|
| Read before write | L033, L075 | Always read fresh from repo before writing any file |
| Complete files only | L074 | Never patches, never diffs — full replacement files |
| Atomic conditionals | L076 | Any if/else chain edit: show entire chain in one block |
| Three-point prop chain | L054 | New prop: add in parent state + pass + child destructure simultaneously |
| File push order | L017 | New files first, files that import them last |
| Self-document | L077 | Update masterseed + lessons_learned after every fix commit |
| Archive prompts | — | Move completed prompts to docs/prompts/ stamped ✅ COMPLETE |

*(L-numbers are project-specific — reference your own lessons_learned.md)*
