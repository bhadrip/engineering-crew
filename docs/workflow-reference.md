# Workflow reference

## Start, inspect, and replay runs

Keep the project JSON, brief, agent profiles, and assignment inputs in Git.
A run reads the committed files from `HEAD` by default. Validate a configuration
before starting a run with it.

```sh
node bin/crew.mjs project validate --project examples/hello-world/crew.project.json
node bin/crew.mjs project validate --project examples/hello-world/website.crew.project.json
node bin/crew.mjs --help
```

For a replay, pass `--ref <commit>` to `run start` and use a fresh run ID.
Use `--repo <checkout>` to select a separate checkout. When a checkout contains
multiple projects, select the browser view with `crew ui --project-id <project>`
or `crew ui <run>`.

The browser and CLI read the same run. Use `workspace show` to list projects
and epics, `run show <run>` for the run record, and
`artifact read <run> <artifact>` for a specific attachment.
`task dispatch --events` emits machine-readable attempt events.

## Review and fix a candidate

An implementation review reports findings on a specific candidate diff. A
`blocker` prevents acceptance. A `backlog` finding stays visible in the epic
and allows the handoff to proceed.

In the website example, the decision owner can use **Reviews → Request fix
loop** after all configured reviewers return evidence for the same candidate
and at least one reports a blocker. The loop must be within the configured
limit, and active attempts on the candidate must finish first. The CLI offers
the same action.

```sh
node bin/crew.mjs run fix <run> <build-attempt-id> --note "Address the blockers"
```

The fix loop reopens the build and its downstream tasks. Dispatch the build
again to send the implementer the prior diff, findings, and decision note.
The replacement must change the candidate source, and its reviewers must
review it again. Planning and earlier attempts stay in the run history.

Configure the build task, review tasks, and decision owner under
`orchestration` in the epic JSON. Set `maxFixLoops` from 0 to 5. Each review
returns a required `review-findings` JSON array whose entries have a stable
`id`, a `severity`, a `title`, and `evidence`. The delivery task depends on
the reviews it needs. Configuration changes apply to new runs.
[Website configuration](../examples/hello-world/website.crew.project.json)

## Evidence and usage

Run records and attachments live under `engineering-crew/runs` inside the
checkout’s Git directory. A downstream attempt records the accepted producer,
output slot, attempt, artifact ID, and digest for each input. The build runner
creates an isolated Git candidate ref. Where configured, author tests and
independent QA produce separate Docker receipts tied to the tested commit.
The website smoke test checks source. Rendered appearance and interaction
require browser evidence.

Open **Usage** or run `run show` to inspect reported token totals across
attempts, including retries. Set `costOwner` at project level or
`budget.costOwner` per task. New tasks fall back to their decision owner.
For estimated USD cost, pin `runtime.model` and set `inputUsdPerMillion` and
`outputUsdPerMillion` under `runtime.tokenRates`. The optional
`cachedInputUsdPerMillion` defaults to the input rate.
Set `budget.costTargetUsd` per task to track its combined attempt cost.
Missing usage or rates leave the corresponding estimate unknown.

To export selected evidence for deeper inspection, see the
[Langfuse setup guide](langfuse.md).
