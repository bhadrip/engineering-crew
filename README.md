# Engineering Crew

Engineering Crew gives a project a configurable crew and a place to follow its
epics. The browser and automation use the same CLI. The Pet Store workflow
runs Product and Lead reviews, SDM planning and approval, a scoped build,
independent Docker QA, and delivery review.

The pilot project is **Pet Store**, with **Beaver Crew** as its configured team.
Epic 1 proposes a catalog command for the standalone Hello World example.
Run the implementation with `node examples/hello-world/hello.mjs --list-pets`.
Epic 2 plans a catalog website. Its UX Designer and Visual Designer each
review the brief, then hand their accepted recommendations to the SDM.

## Run the pilot

Use Node.js 22+, Git, a logged-in Codex CLI, and Docker with the pinned Node
image from `examples/hello-world/crew.project.json` available locally. Run
these commands from a checkout that has committed the files under
`examples/hello-world`. For a replay, use `--ref` to pin the pre-change commit.
Use `--repo /path/to/checkout` before the command for a separate project checkout.

```sh
node bin/crew.mjs project validate --project examples/hello-world/crew.project.json
node bin/crew.mjs run start epic-1 --project examples/hello-world/crew.project.json
node bin/crew.mjs run start epic-2 --project examples/hello-world/website.crew.project.json
node bin/crew.mjs ui
```

The printed loopback URL opens **Pet Store** directly. Find an epic by name or
filter by status. In an epic, **Overview** shows recent decisions, **Workflow**
opens handoffs, **Checks** shows observed results when configured, **Usage**
shows task ownership and usage, and **Activity** shows the full history.
Search the current run by handoff name, artifact title, criterion
ID, or commit. The **Beaver Crew** link opens the project roster.

For automation, use `node bin/crew.mjs --help`. `workspace show` lists projects
and epics in the selected checkout. `run show` returns the exact run the UI
displays, `artifact read` opens one attachment, and `task dispatch --events`
emits machine-readable attempt events. `npm test` runs the offline checks.

Git controls the project configuration, epic brief, profile instructions, and
other assignment inputs. Starting a run pins them to the selected commit.
Attempt records and their attachments live in the checkout's private Git
directory under `engineering-crew/runs`. The Codex receipt shows runtime outcome
and reported usage when available. The build runner creates an isolated Git
candidate ref. Separate Docker receipts record the author tests and independent
QA outcomes on that same commit.

Publish a Codex receipt or opt in to capturing and publishing the prompt,
response, and runner checks for a handoff. Verified traces appear in the epic
view. [Langfuse setup](docs/langfuse.md)

Codex profiles receive only the inputs in their task packets. Configure roles,
dependencies, allowed build outputs, and verification in the project JSON.
Each downstream attempt records the accepted producer, slot, attempt,
artifact ID, and digest for every handoff. A retry receives the decision
owner's rework note with its pinned inputs.

Set a project `costOwner` or override it with `budget.costOwner` on an
individual task. The decision owner is the fallback for new tasks. The cost
owner uses **Usage** or `run show` to review totals, missing records, and
overruns before deciding whether more attempts are warranted. To estimate USD
cost, pin `runtime.model` and provide `runtime.tokenRates` with
`inputUsdPerMillion`, `outputUsdPerMillion`, and optionally
`cachedInputUsdPerMillion`. If the cached rate is omitted, all input uses
the input rate. A task can set `budget.costTargetUsd` for the sum of its
attempts, including retries. Cost is an estimate from reported tokens.
Missing usage or rates leave the cost unknown.

The preview runs locally. If the checkout has runs for multiple projects,
choose one with `crew ui --project-id <project>` or `crew ui <run>`.
[V1 design](docs/design/engineering-crew.md)
