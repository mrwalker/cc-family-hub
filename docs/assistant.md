# The assistant

A family's assistant is an agent that lives outside the hub, usually in the family's
chat, and keeps the hub's records up to date: "add Casa Luna to the beach trip", "we need
oat milk". It works through a small API on the Worker and a few `family-hub` commands.

The assistant can be any agent that runs shell commands on the machine where the pipeline
runs. Nothing here depends on which one, or on which chat it's in.

## How it's kept safe

- **Its own token.** The assistant uses `AGENT_TOKEN`, not the pipeline's `PUBLISH_TOKEN`,
  so either can be replaced without the other.
- **The channel decides what it may touch.** Each chat channel is mapped in `family.yaml`
  to one trip, or to a part of the household. A request from a trip's channel can only
  change that trip. The Worker enforces this; the request can't override it.
- **One small change per command.** A command adds one restaurant or checks off one item.
  It never sends a whole record, so it can't overwrite what someone else changed.
- **Nothing is shortened to fit.** Text that's too long is refused with a message that
  says so.
- **Everything is logged and can be undone.** The log records who asked, in which channel,
  and what reverses the change. Adults see it, and undo from it, on `/household/` ›
  Assistant.
- **Taking things away waits for an adult.** Removing from a trip or the grocery list,
  changing a trip's dates and archiving a task are held until an adult approves them on
  `/household/` › Assistant, or from an `ops` channel. Never from the channel that asked.
  A waiting change expires after 72 hours, and is checked again when it's approved.
- **The household's own rules apply.** Tasks, chores and movie marks are made through the
  household API as the family member who asked, so a child can tick a chore but can't add
  a task, just as on `/household/`.

One token can't prove which person or channel a request really came from; who asked is
the assistant's word, by chat id or by name. The scope
protects against an assistant that's confused, not against a stolen token. Keep the token
with your other secrets.

## Setting it up

1. Make a token and give it to the Worker:

   ```bash
   openssl rand -hex 32
   npx wrangler secret put AGENT_TOKEN
   ```

2. Put the same value in `secrets.yaml` on the machine where the assistant runs:

   ```yaml
   hub-api:
     url: "https://hub.example.com"
     publishToken: "..."
     agentToken: "..."            # = the Worker's AGENT_TOKEN
     accessClientId: "...access"
     accessClientSecret: "..."
   ```

3. Map the channels in `family.yaml`. Use each channel's id, not its name (in Slack:
   the channel's details, at the bottom):

   ```yaml
   hub:
     agent:
       channels:
         C0EXAMPLE01: { trip: "beach-jul-2027" }   # this channel is that trip
         C0EXAMPLE02: { scope: household }          # groceries; reads trips
         C0EXAMPLE03: { scope: grocery }            # groceries only
         C0EXAMPLE04: { scope: ops }                # everything, any trip by name; approvals
         C0EXAMPLE05: { scope: pets }               # the pets' tasks
         C0EXAMPLE06: { place: "place-3f9a…" }      # one house's tasks (its id: /household/ › House)
         C0EXAMPLE07: { scope: movies }             # movie marks
   ```

   | Scope | Can |
   |---|---|
   | `trip` | read and change that trip |
   | `household` | groceries, tasks, chores, movies; read trips |
   | `grocery` | groceries |
   | `pets` | the pets' tasks |
   | `place` | that house's tasks |
   | `movies` | movie marks |
   | `ops` | everything, any trip by `--trip`; approve and turn down waiting changes |

4. Tell the hub who's who in the chat, so the log can name them. In each member's
   `members/<id>.yaml`, and for trip guests under `hub.guests`:

   ```yaml
   # members/sam.yaml
   slack: "U0EXAMPLE01"
   ```

   ```yaml
   # family.yaml
   hub:
     guests:
       grandma: { email: "grandma@example.com", slack: "U0EXAMPLE09" }
   ```

   Anyone in a trip's channel can add to that trip, known to the hub or not. Only family
   members can change the grocery list.

5. Push, so the hub deploys, then check: `npx family-hub doctor`.

## Commands

Every command but `doctor` says where it's working with `--channel <id>` (or the
`HUB_AGENT_CHANNEL` environment variable). A change also says who asked, with
`--for <their chat id>` (or `HUB_AGENT_FOR`). An assistant that doesn't have the id gives
their name instead (`--for "Sam"`): a member's or guest's id or name finds them. With a
chat id, `--for-name "Pat"` adds a name for someone the hub doesn't know. In a trip's channel the trip is that one; from an `ops` channel, name it
with `--trip <id>`.

| Command | Does |
|---------|------|
| `family-hub trip list` | The trips this channel can see |
| `family-hub trip show` | One trip: dates, restaurants, things to do, ideas |
| `family-hub trip brief` | The facts for a briefing: days to go, today's and tomorrow's plan, who has packed, quest scores, what still needs booking |
| `family-hub trip add-idea --text T` | Adds an idea |
| `family-hub trip add-restaurant --name N [--price '$$'] [--type T] [--note T]` | Adds a restaurant |
| `family-hub trip add-activity --name N [--emoji E] [--note T]` | Adds a thing to do |
| `family-hub grocery list` | What's left to buy |
| `family-hub grocery add --name N [--qty 2] [--store S]` | Adds an item |
| `family-hub grocery check --name N` | Checks an item off |
| `family-hub trip remove-idea --text T`, `remove-restaurant --name N`, `remove-activity --name N` | Removes one (waits for a yes) |
| `family-hub trip set-dates --start D --end D` | New dates (waits for a yes) |
| `family-hub grocery remove --name N` | Takes an item off the list (waits for a yes) |
| `family-hub task list [--days 30]` | Tasks due soon, and what was done lately |
| `family-hub task add --title T [--pet P \| --place P] [--kind K] [--due D] [--every N --unit month]` | Adds a task |
| `family-hub task done --title T` | Marks a task done; a repeating one moves on |
| `family-hub task archive --title T` | Archives a task (waits for a yes) |
| `family-hub chore list`, `chore done --title T` | Today's chores, and ticking one |
| `family-hub movie list`, `movie mark --title T [--mark want\|seen\|none] [--who member]` | Movies, and marks |
| `family-hub proposal list`, `proposal approve <id>`, `proposal reject <id>` | What's waiting; deciding it (an `ops` channel, an adult) |
| `family-hub inbox poll [--json]`, `inbox claim <id>…`, `inbox reply <id> --text T` | Questions from the hub, and answering them (an `ops` channel) |
| `family-hub note set --text T [--until D]` | A note on the hub for this trip or home |
| `family-hub calendar [--from D] [--to D \| --days 14]` | The family's calendar. In a trip's channel, since guests are there, only the trip's days (from two days before to the day after) and only events about the trip: on the household calendar, mentioning the destination, or about travel (flights, hotels, check-ins, reservations, tours) |
| `family-hub log list [--limit 20]` | What the assistant changed lately |
| `family-hub log undo <id>` | Reverses one change |
| `family-hub doctor` | Checks the live hub; needs no channel |

A value of `-` reads that text from stdin, so an apostrophe can't break a command:

```bash
echo "Don't miss the sunset at the pier" | npx family-hub trip add-idea --text - --channel C0EXAMPLE01 --for U0EXAMPLE01
```

`trip show`, `trip brief` and `doctor` take `--json` for the full answer.

### What a command prints

The last line always says how it went, and the exit code matches:

| Last line | Exit | Means |
|-----------|------|-------|
| `TRIP OK: Added "Casa Luna" to Beach week's restaurants (log 3f9a2c1b0e; …)` | 0 | Done |
| `TRIP OK: nothing to do. "Casa Luna" is already in …` | 0 | Already so; safe to repeat |
| `TRIP PENDING: Remove "Casa Luna" …: waiting for an adult's yes (proposal …)` | 0 | Held for an adult; don't repeat it |
| `TRIP FAILED: name: no more than 80 characters …` | 1 | Refused. Change the command; don't repeat it |
| `TRIP FAILED: the command was mistyped (above)` | 2 | The usage line above shows the form |
| `TRIP FAILED: Couldn't reach the hub …` | 3 | Try again later |

### The briefing facts

`trip brief` works everything out in the Worker, so the assistant only has to write it
up. The plan, the packing lists and anything marked to book come from the trip app's
`trip-data.js` as of the last deploy. A schedule item tagged with a leading `!` counts as
still to book or ask:

```js
{ time: "09:00", title: "Canoe rental", tags: ["!Book two canoes"] }
```

If the hub's trip record and the trip app disagree about the dates, the facts say so.

### The doctor

`family-hub doctor` asks the hub what's deployed and how fresh its data is, and prints one
`ok` or `FAIL` line per check, ending `DOCTOR OK` or `DOCTOR FAILED: n problems`. It checks
that the plan and family data were published in the last 26 hours (`--max-age-hours`),
the bindings, the database schema, the assistant's setup, and that every trip app names a
trip the hub has. It makes no judgment calls, so it can run on a schedule without an
assistant and report only when it fails.

## Asking from the hub

The hub page has an **Ask** button (named for `hub.agent.name`), and each trip app has an
**Ask** panel on its Today view. A question goes to the assistant, and its answer shows
there in a minute or two. The family can ask about home or any trip; a trip's guests only
about their trips. A trip app keeps a question written offline and sends it on the next
sync.

Nothing reaches the assistant by itself: a script on the assistant's machine polls
(`family-hub inbox poll` from an `ops` channel), claims each question
(`inbox claim <id>`), posts it in the channel its scope maps to, has the assistant answer
there, and hands the answer back (`inbox reply <id> --text -`). A claimed question that
isn't answered in 15 minutes is offered again.

The assistant can also leave a **note** for a trip or for home, shown at the top of the
Ask panels until a date: `family-hub note set --text - --until 2026-12-01`, from that
trip's or the household's channel. A trip briefing is a good note.

A trip app change reaches phones only after the family bumps each trip's `sw.js` version
(see [trip-apps.md](trip-apps.md)).

## The API

All under `/api/agent`, with `Authorization: Bearer <AGENT_TOKEN>` (and the Access service
token, if the hub is behind Cloudflare Access).

| Method | Path | Does |
|--------|------|------|
| GET | `/health` | What's deployed, the schema, when data was published. The publish token works here too |
| GET | `/trips?channel=` | The trips the channel may see |
| GET | `/trip?channel=&trip=` | One trip, without its album link |
| GET | `/facts/trip?channel=&trip=` | The briefing facts |
| GET | `/grocery?channel=` | The grocery list |
| GET | `/tasks?channel=&days=` | Tasks due soon in the channel's scope |
| GET | `/chores?channel=` | Today's chores |
| GET | `/movies?channel=` | Movies, and who wants or has seen each |
| GET | `/log?channel=&limit=` | Changes made for this channel's scope (all of them, from `ops`) |
| GET | `/proposals?channel=` | Changes waiting for a yes |
| POST | `/ops` | `{ op, args, channel, actor: { slack?, name? } }` → `{ status: "applied" \| "unchanged", summary, logId? }`, or `{ status: "pending", proposalId, expiresAt, summary }` |
| POST | `/log/:id/undo` | `{ channel, actor }`; from the channel the change was made for, or `ops` |
| POST | `/proposals/:id/approve`, `/reject` | `{ channel, actor }`; from an `ops` channel, by an adult |

| GET | `/calendar?channel=&from=&to=&days=` | Every member's events (and the household calendar's), at most 90 days; a trip's channel gets its trip's days only |
| GET | `/inbox?channel=` | Questions from the hub to answer (an `ops` channel) |
| POST | `/inbox/claim` | `{ channel, ids }` → `{ claimed }` |
| POST | `/inbox/:id/reply` | `{ channel, body }` |
| POST | `/notes` | `{ channel, body, until? }`, from a trip's or the household's channel |

The pages use `GET`/`POST /api/household/inbox` and `GET`/`POST /api/trip/:appId/inbox`,
with the viewer's sign-in.

And for the household page, with the viewer's sign-in (adults): `POST /api/household/agent/proposals/:id/approve|reject` and `POST /api/household/agent/log/:id/undo`.

Each op is defined in `app/worker/agent-ops.js` with its tier and the scopes that may ask
for it.
