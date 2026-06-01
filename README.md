# atix

`atix` is a small local CLI for passing work between humans and coding agents.
It stores ticket and ask roots, durable thread messages, final results, and
attached docs in one SQLite file.

The goal is not to create a grand agent platform. The goal is to have a boring,
durable place for short-lived agent handoffs that should be logged, but should
not turn the repository into a pile of temporary notes.

Default database path:

```text
~/.local/share/atix/atix.db
```

## Why this exists

You can already use tools like `claude -p` or `codex:rescue` for one-off
handoffs. That is fine until the handoff becomes part of the normal development
loop.

The practical problems this project is trying to solve are:

- As of June 2026, repeated `claude -p` handoffs are less attractive for this
  workflow because they are a separate cost path.
- `codex:rescue` is useful, but not stable enough to be the durable handoff
  layer.
- Copy-paste loses the trail: what was asked, who answered, how the thread
  changed, and what final result closed it.
- Putting every temporary agent conversation into repo docs makes the repo
  noisy.
- Agent handoffs often need context files, but those files should be captured at
  the time of the request rather than treated as long-lived repo artifacts.
- Scripts and agents need JSON they can poll without scraping human output.

If a note is part of the long-term design, keep it in the repo. If it is
agent-to-agent traffic that only needs to be recoverable, put it in `atix`.

## What it is

- A local ticket board backed by SQLite.
- A CLI shared by humans, Claude Code, Codex, scripts, and sub-agents.
- A durable log of requests, thread messages, final results, and embedded docs.
- A pull-based inbox: workers receive actionable items from named channels.
- Today, a single-machine tool. Filesystem permissions are the security boundary.

## What it is not

- Not a workflow engine.
- Not a message broker.
- Not a distributed queue today.
- Not a web app.
- Not a replacement for project documentation.

## Current boundary and later direction

The current version is intentionally local-first: one SQLite file, one machine,
and clear CLI behavior for agents.

A later storage adapter boundary could support:

- Postgres for a shared team board on the same codebase.
- Redis if the useful shape becomes a short-lived coordination queue.

That would make it possible for multiple teammates and their agents to exchange
review requests, implementation tasks, and final results through shared
channels. That is not implemented today. The important constraint is that the
agent-facing CLI contract should remain narrow and boring even if the backend
changes.

## Official workflow commands

Most users should start with these commands:

| Command | Purpose |
| --- | --- |
| `atix send` | Create one ticket for one channel. |
| `atix ask` | Create multiple opinion tickets as one ask group. |
| `atix inbox` | Receive one actionable item from a channel, optionally waiting. |
| `atix take` | Receive one exact ticket by ID and get a receipt. |
| `atix reply` | Add information or docs to a ticket. |
| `atix done` | Finish claimed work using the receipt from `inbox` or `take`. |
| `atix thread` | Read or poll the conversation for a ticket or ask group. |
| `atix show` | Read the current state snapshot, optionally waiting for close. |

The normal loop is:

```text
send -> inbox/take -> reply* -> done -> thread/show
```

`send` and `ask` create work. `inbox` receives the next available item and
returns a receipt. `take` receives one exact ticket by ID and returns the same
kind of receipt. `done` requires that receipt so the worker that claimed the
ticket is the worker that closes it. Use `thread` for the conversation and
`show` for the current state snapshot.

## Quick start

```bash
# Create the database once.
atix init

# Create channels explicitly. Channels are not auto-created.
atix channel add review.codex --desc "Codex review requests"

# Create one ticket.
ID=$(atix send \
  --to review.codex \
  --title "review auth refactor" \
  --body-file ./request.md \
  --json | jq -r .ticket.id)

# A worker receives one actionable item.
ITEM=$(atix inbox --from review.codex --json)
TICKET=$(echo "$ITEM" | jq -r .ticket.id)
RECEIPT=$(echo "$ITEM" | jq -r .receipt)

# The worker can add context before finishing.
atix reply "$TICKET" --body "I am checking the auth boundary."

# The worker finishes the ticket.
atix done "$TICKET" --receipt "$RECEIPT" --body "LGTM. One naming nit."

# Anyone can read the conversation later.
atix thread "$ID" --with-docs

# Or read the current state snapshot.
atix show "$ID" --with-docs
```

An empty inbox is not a failure. In JSON mode, `inbox` returns `ok: false` with
`type: "empty"` and exits successfully when there is no available item.

Use `take` when the caller already knows the exact ticket to work on:

```bash
ITEM=$(atix take "$ID" --json)
RECEIPT=$(echo "$ITEM" | jq -r .receipt)
```

If the ticket is open, `take` claims it and returns a receipt. If the same
`ATIX_AGENT` and `ATIX_SESSION` already claimed it, `take` returns the existing
receipt. If another worker claimed it, or the ticket is already closed or
canceled, `take` exits with a conflict.

## Embedded docs

`send`, `ask`, `reply`, and `done` can attach named docs:

```bash
atix send --to review.codex --title "review diff" \
  --body "Please review this change." \
  --doc-file diff=./diff.patch \
  --doc notes="Focus on auth and migration risk."

atix reply "$TICKET" --doc-file notes=./review-notes.md

printf '%s\n' "final notes" | atix done "$TICKET" \
  --receipt "$RECEIPT" \
  --doc-stdin final-notes
```

Docs are embedded into SQLite at command time and attached to the thread message
created by that command. `--doc-file name=path` stores the file content when
`send`, `ask`, `reply`, or `done` runs. It does not store a durable path
reference, so later edits to the file do not change the thread.

Doc flags:

| Flag | Meaning |
| --- | --- |
| `--doc name=text` | Attach inline text. |
| `--doc-file name=path` | Read a UTF-8 file and attach its current content. |
| `--doc-stdin name` | Read one doc from standard input. |

Use `thread --with-docs` to include message-owned docs in the conversation
output. `show --with-docs` includes docs in the current state snapshot. For
individual tickets, human output lists the attached doc names and sizes.

## Asking multiple reviewers

Use `ask` when the same question should go to multiple channels and be tracked
as one group.

```bash
GROUP=$(atix ask \
  --to review.codex \
  --to review.claude \
  --title "review queue API" \
  --body-file ./question.md \
  --doc-file diff=./diff.patch \
  --json | jq -r .ask_group.id)

atix thread "$GROUP" --with-docs --json
```

Each channel receives its own child ticket. `thread` accepts either the ask
group ID or an individual ticket ID. For an ask group, `thread <group-id>` is
the aggregate conversation across the child tickets. Use `show` when an agent
needs the current state snapshot for the group or one child ticket.

## Blocking and agent polling

Blocking means "wait up to this duration" and return early when the condition is
met. It is polling, not push notification.

Agents and scripts should use `--json` and parse the result instead of scraping
human output:

```bash
export ATIX_AGENT=codex
export ATIX_SESSION="$(uuidgen)"

ITEM=$(atix inbox --from review.codex --wait 30m --json)

if ! echo "$ITEM" | jq -e '.ok == true' >/dev/null; then
  exit 0
fi

ID=$(echo "$ITEM" | jq -r .ticket.id)
RECEIPT=$(echo "$ITEM" | jq -r .receipt)

# Do the work...

atix done "$ID" --receipt "$RECEIPT" --body-file ./answer.md --json
```

Useful blocking commands:

```bash
# Wait for one actionable inbox item.
atix inbox --from review.codex --wait 30m --json

# Long-poll for new thread messages after a cursor.
atix thread "$ID" --after "$CURSOR" --wait 30m --json

# Wait for one ticket or ask group to close, then return its snapshot.
atix show "$ID" --wait 30m --with-docs --json
```

`thread --wait` is message polling. If no new message arrives before the
timeout, it exits 0 and returns JSON with `timeout: true`.

`show --wait` is close-state waiting. It waits for the ticket or ask group to
close and returns the current state snapshot.

Human desktop notification with `--notify` is not implemented yet. Commands
reject it for now.

## Channels

A channel is a durable address such as `review.codex`, `work.todo`, or
`team.architect`.

Create channels explicitly:

```bash
atix channel add review.codex --desc "Codex reviews"
```

This avoids typo-created ghost queues. Channel names must match:

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

## Advanced commands

The primitive commands remain available for lower-level workflows, debugging,
and compatibility:

```text
push, claim, wait, list, release, cancel, recover, channel, whoami
```

They are not the normal README path. Prefer `send`, `ask`, `inbox`, `take`,
`reply`, `done`, `thread`, and `show` unless you need a specific primitive
behavior.

## Install and development

`atix` runs on Bun and uses Bun's built-in SQLite support.

Run from source:

```bash
bun run src/cli.ts <command>
```

Build a standalone binary:

```bash
bun run build
./atix init
```

On macOS, a compiled Bun binary may need ad-hoc signing:

```bash
codesign --remove-signature atix
codesign -s - atix
```

Put the resulting `atix` binary somewhere on your `PATH` if you want to use the
examples above as written.

Run tests:

```bash
bun test
```

## Environment

| Variable | Purpose |
| --- | --- |
| `ATIX_DB` | Override the database path. |
| `ATIX_AGENT` | Agent name recorded on tickets and thread messages. |
| `ATIX_PROJECT` | Project name recorded in metadata. |
| `ATIX_SESSION` | Stable session id. Agents should set this explicitly. |
| `ATIX_ORPHAN_TTL` | Age after which claimed tickets are shown as orphaned. Default: `30m`. |
| `ATIX_MAX_BODY_BYTES` | Hard body and doc size limit. Default: `16777216` bytes. |
