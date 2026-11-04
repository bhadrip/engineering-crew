# Workflow reference

## Start, inspect, and replay runs

Set `CREW_DATABASE_URL` to the connection URL for the customer database.
Crew initializes its own `engineering_crew` schema on first use.
Use one database per Crew installation. Run IDs are unique in that database.

Submit project JSON with `project register --file`. The registration command
captures the configured source, prompts, skills, and default input files
from a Git commit. It defaults to `HEAD`. Use `--repo <checkout>` and
`--ref <commit>` to select their source. Supply private briefs and other
run inputs with `--input <id>=<file>` to capture them directly from disk.
You can keep the JSON outside the checkout or discard it after registration.
Use `project validate --file` to validate an import before registering it.

```sh
node bin/crew.mjs project register --file /path/to/epic.json --input brief=/path/to/brief.md
node bin/crew.mjs project versions --project pet-store --epic epic-1
node bin/crew.mjs project show --project pet-store --epic epic-1 --version 1
node bin/crew.mjs run start replay-1 --project pet-store --epic epic-1 --version 1
```

Each changed registration creates the next immutable version for that
project and epic. An identical registration returns the latest version.
`run start` uses the latest by default. Replay with a fresh run ID and the
original `--version`. Existing runs retain their configuration and inputs.
Keep prompt files in Git. A profile can list its own skills under
`skills/<agent-id>/<skill>/SKILL.md` and explicitly opt into shared skills
under `skills/common/<skill>/SKILL.md` in its repository.

The browser and CLI read the same database. Use `workspace show` to list
projects and epics with runs, `run show <run>` for the run record, and
`artifact read <run> <artifact>` for a specific attachment.
Select a browser project with `crew ui --project-id <project>` or
`crew ui <run>`. `task dispatch --events` emits machine-readable events.

## Import existing runs

Stop active local Crew processes and wait for assignments to finish before
importing. Point Crew at the original checkout so it can capture the
baseline and legacy candidate files, then run:

```sh
node bin/crew.mjs db import-local --repo /path/to/checkout
```

The import preserves run IDs, evidence, Git provenance, and the configuration
snapshot attached to each historical run. It copies existing provisioner
bindings where no database binding exists. Legacy files and refs remain in
place for verification. Repeating the import skips identical records, even
after they advance in Postgres. A conflicting run ID or a missing required
Git object rolls back the import. Register a project version separately
when you want to start new runs.

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

Administrators can register a project configuration with `resourcePolicy`.
Rules are pinned when the run starts. Exact action and target rules take precedence
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

Register an automatic provisioner in Postgres with an exact project, action,
and target. Restrict writes to the provisioner table to trusted operators.
The executable runs on the worker host.

```sh
node bin/crew.mjs provisioner set create-table dev.catalog --project pet-store -- /opt/crew/bin/ensure-dev-catalog
node bin/crew.mjs provisioner remove create-table dev.catalog --project pet-store
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

Run records and attachments live in Postgres. A downstream attempt records
the accepted producer, output slot, attempt, artifact ID, and digest for
each input. The build runner records candidate files, the revision, and its
diff in the run. Where configured, author tests and independent QA produce
separate Docker receipts tied to that revision. QA materializes the accepted
files from Postgres.
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

**Usage** shows workflow totals and a breakdown by agent, task, and attempt.

**Usage** includes retries and work on superseded candidates. Total attempt
time adds up finished attempts, including runner checks, and can exceed the
attempt window when work overlaps. The window runs from the first recorded
start to the last recorded finish among timed attempts. Open an attempt to see
its token breakdown and Codex process time when recorded. Quality signals
include current handoff acceptance and recorded Docker checks, plus historical
rework decisions. These same metrics are available in `run show`.

To export selected evidence for deeper inspection, see the
[Langfuse setup guide](langfuse.md).
