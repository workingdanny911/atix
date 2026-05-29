# atix

`atix` is a small local CLI for passing work between humans and coding agents.
It stores tickets, replies, and final results in one SQLite file.

The goal is not to create a grand agent platform. The goal is to have a boring,
durable place for short-lived agent handoffs that should be logged, but should
not turn the repository into a pile of temporary notes.

## Why this exists

You can already use tools like `claude -p` or `codex:rescue` for one-off
handoffs. That is fine until the handoff becomes part of the normal development
loop.

The practical problems this project is trying to solve are:

- Repeated `claude -p` calls are becoming a separate cost concern in this
  workflow.
- `codex:rescue` is useful, but not stable enough to be the durable handoff
  layer.
- Copy-paste loses the trail: what was asked, who answered, and whether the
  answer was final.
- Putting every temporary agent conversation into repo docs makes the repo
  noisy.

`atix` keeps that temporal traffic outside the repo by default, while still
leaving a stable ticket ID you can mention in a plan, PR note, or commit.

Default database path:

```text
~/.local/share/atix/atix.db
```

## What it is

- A local ticket board backed by SQLite.
- A CLI shared by humans, Claude Code, Codex, scripts, and sub-agents.
- A durable log of requests, replies, and final results.
- A pull-based queue: workers claim work from named channels.
- Today, a single-machine tool. Filesystem permissions are the security boundary.

## What it is not

- Not a workflow engine.
- Not a message broker.
- Not a distributed queue today.
- Not a web app.
- Not a replacement for project documentation.

If a note is part of the long-term design, keep it in the repo. If it is
agent-to-agent traffic that only needs to be recoverable, put it in `atix`.

## Current boundary and later direction

The current version intentionally starts with SQLite because the first problem
is local: keep agent handoff logs durable without creating temporal repo docs.

A reasonable later direction is to add storage adapters:

- SQLite for one developer on one machine.
- Postgres for a shared team board on the same codebase.
- Redis if the useful shape becomes a lightweight queue with short-lived
  coordination.

That would make it possible for team members to exchange review requests,
implementation tasks, and agent-generated results through shared channels such
as `review.codex`, `review.claude`, or `team.frontend`.

That is not implemented yet. The important constraint is that the CLI contract
should stay boring: `push`, `claim`, `reply`, `done`, `show`, with JSON output
for agents. The backend can change later only if those semantics stay clear.

## Install

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
examples below as written.

## Quick start

```bash
# Create the database once.
atix init

# Create a channel explicitly. Channels are not auto-created.
atix channel add review.codex --desc "Codex review requests"

# Push a ticket.
ID=$(atix push \
  --to review.codex \
  --title "review auth refactor" \
  --body-file ./diff.patch \
  --json | jq -r .id)

# A worker claims the oldest open ticket from the channel.
CLAIM=$(atix claim --from review.codex --json)
TOKEN=$(echo "$CLAIM" | jq -r .claim_token)
TICKET=$(echo "$CLAIM" | jq -r .id)

# The worker writes the final result.
atix done "$TICKET" --token "$TOKEN" --body "LGTM. One naming nit."

# Anyone can read the ticket later.
atix show "$ID" --with-replies
```

The normal loop is:

```text
push -> claim -> reply* -> done -> show
```

## Core concepts

### Channels

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

### Tickets

Tickets have four stored states:

```text
open -> claimed -> done
  |       |
  |       +-> release -> open
  +---------------------> canceled
```

- `open`: waiting to be claimed.
- `claimed`: a worker has the claim token.
- `done`: closed with success or failure details in the final reply.
- `canceled`: withdrawn.

Closed tickets stay in the database so the handoff log remains recoverable.

### Replies

Replies are the conversation attached to a ticket. Anyone can add a reply.
`done --body` creates the final reply.

This keeps the question, progress notes, and answer in one place instead of
spreading them across scratch files.

### Claims

`claim` is pull-based and atomic. A worker takes the oldest open ticket from a
channel and receives a claim token. `done` and `release` require that token.

Two workers racing on the same channel should not receive the same ticket.

## Commands

| Command | Purpose |
| --- | --- |
| `atix init` | Create or migrate the local database. |
| `atix channel add/ls/archive/unarchive` | Manage named channels. |
| `atix push` | Create a ticket on a channel. |
| `atix claim` | Atomically claim the oldest open ticket from a channel. |
| `atix reply` | Add a non-final reply to a ticket. |
| `atix done` | Close a claimed ticket and optionally write the final reply. |
| `atix release` | Return a claimed ticket to `open`. |
| `atix cancel` | Close a ticket as canceled. |
| `atix wait` | Poll until a ticket is done or receives a new reply. |
| `atix list` | List and filter tickets. |
| `atix show` | Show one ticket, optionally with replies. |
| `atix whoami` | Show the identity metadata that will be recorded. |
| `atix recover` | Re-issue a claim token for the same agent/session. |

## Bodies

`push`, `reply`, and `done` can read text in three explicit ways:

```bash
atix push --to ch --title t --body "inline text"
atix push --to ch --title t --body-file ./request.md
atix push --to ch --title t --body-stdin
```

Use `--body-file` for diffs and larger payloads. The body must be valid UTF-8
and must not contain NUL bytes.

## Scripts and agents

Agents and scripts should use `--json` and parse the result instead of scraping
human output.

```bash
export ATIX_AGENT=codex
export ATIX_SESSION="$(uuidgen)"

JSON=$(atix claim --from review.codex --wait 0 --json)

if ! echo "$JSON" | jq -e '.ok == true' >/dev/null; then
  exit 0
fi

ID=$(echo "$JSON" | jq -r .id)
TOKEN=$(echo "$JSON" | jq -r .claim_token)

# Do the work...

atix done "$ID" --token "$TOKEN" --body-file ./answer.md --json
```

Important output details:

- `atix list --json` emits JSONL: one ticket object per line.
- `atix channel ls --json` emits one JSON array.
- An empty `claim --wait 0 --json` returns
  `{"ok":false,"timeout":true,...}` with exit code `0`.
- `wait` timeout returns exit code `5`. That means "still pending", not
  "failed".

## Environment

| Variable | Purpose |
| --- | --- |
| `ATIX_DB` | Override the database path. |
| `ATIX_AGENT` | Agent name recorded on tickets and replies. |
| `ATIX_PROJECT` | Project name recorded in metadata. |
| `ATIX_SESSION` | Stable session id. Agents should set this explicitly. |
| `ATIX_ORPHAN_TTL` | Age after which claimed tickets are shown as orphaned. Default: `30m`. |
| `ATIX_MAX_BODY_BYTES` | Hard body-size limit. Default: `16777216` bytes. |
| `NO_COLOR` | Disable colored human output. |

Database path resolution:

```text
--db PATH
ATIX_DB
$XDG_DATA_HOME/atix/atix.db
~/.local/share/atix/atix.db
```

## Development

```bash
bun test
bun run build
```

Project layout:

```text
src/
  cli.ts
  commands/
  db/
  lib/
test/
docs/planning/
```

The full design spec is in [`docs/planning/SPEC.md`](docs/planning/SPEC.md).
