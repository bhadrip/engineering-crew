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

## Triage a brief and assign a team

New runs default to static triage. At creation, the run records each task's
configured `profileId` and starts the assignments with no prerequisites.
To require a decision at intake, add
`"triage": { "mode": "manual", "owners": ["SDM", "Tech Lead"] }` to the project
JSON. Use `triage.briefInput` to select the input ID if it differs from
`brief`. Add `alternateProfiles` to a task to let the owner choose from other
profiles configured in that project. Each task's `profileId` remains its default.

Open **Triage** in the epic to read the pinned brief and choose **Confirm and
start**. This records the selected owner, reason, brief digest, and profile
revisions, then opens **Workflow** with the initial assignments underway.

```sh
node bin/crew.mjs run triage epic-2 --owner "Tech Lead" \
  --note "Assign the interactive prototype to the frontend specialist." \
  --assign website-build=frontend-engineer
node bin/crew.mjs artifact read epic-2 triage-decision
```

Omit `--assign` to confirm the defaults, or repeat it for multiple tasks.
The CLI waits for the initial assignments to return. Use `--events` to
receive their attempt IDs as soon as they start, or `--no-dispatch` on
`run start` or `run triage` to prepare a run for manual dispatch. Dependent
tasks become available to dispatch after their required handoffs are accepted.

## Resolve resource requests

Open **Needs attention** in the project navigation to see open requests across
work briefs. A request names the action, exact target, and reason and links to
the handoff and execution receipt. For manual setup, create or configure the
resource, then choose **Confirm resource ready** with a short record of what
is available. Use non-secret identifiers in requests and confirmations.

When the last request for a handoff is resolved, Crew starts a new attempt
for that handoff and includes the resolution records as inputs. Paused
attempts stay in history and do not count against the packet's rework limit.
Downstream tasks still wait for an accepted handoff. The CLI uses the same
record and resolution path.

```sh
node bin/crew.mjs run show <run>
node bin/crew.mjs resource resolve <run> <request-id> --note "Catalog table is ready in dev."
```

Administrators can add `resourcePolicy` to the committed project JSON. Rules
are pinned when the run starts. Exact action and target rules take precedence
over action-wide rules. Unmatched requests use manual setup.

```json
{
  "resourcePolicy": {
    "rules": [
      { "action": "create-database", "mode": "deny" },
      { "action": "create-account", "target": "OpenRouter", "mode": "manual" },
      { "action": "create-table", "target": "dev.catalog", "mode": "auto" }
    ]
  }
}
```

- **Manual** waits for operator confirmation.
- **Deny** offers **Continue with alternative**. Crew records the denial and
  sends the alternative to the paused handoff.
- **Auto** requires an exact target and a matching local provisioner.
  An unavailable or failed provisioner leaves the request in the queue
  for manual setup.

To register an automatic provisioner, place an array of entries in
`engineering-crew/provisioners.json` under the checkout's Git directory.
Restrict write access to the local administrator. Each entry binds one
project, action, and target to a fixed executable and arguments.

```json
[
  {
    "project": "pet-store",
    "action": "create-table",
    "target": "dev.catalog",
    "command": ["/opt/crew/bin/ensure-dev-catalog"]
  }
]
```

Use an idempotent executable that exits successfully once the resource is
ready. Crew runs the fixed command directly with a 30-second limit and
records its outcome. Provider credentials belong in the provisioner's
credential store.

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
