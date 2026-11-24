# Langfuse drill-down

Use `crew trace publish` to send one completed Codex attempt to a local
Langfuse project. A verified trace appears under Evidence in the workflow
and full handoff views.

Start a local Langfuse v4 instance and create a dedicated project. Store that
project's `public_key` and `secret_key` in a JSON file with mode `0600` outside
the checkout and its Git directory. Set the destination explicitly.

```sh
export CREW_LANGFUSE_URL=http://127.0.0.1:3312
export CREW_LANGFUSE_PROJECT_ID=your-local-project-id
export CREW_LANGFUSE_CREDENTIALS_FILE=/absolute/path/outside/the/repo/credentials.json
node bin/crew.mjs trace publish epic-1-delivery product-review
```

Replace the run and task IDs with the values from `crew run show`. The latest
attempt is selected by default. Add `--attempt` with an ID to select a specific
attempt. The publisher checks the API key's
project, submits the OTLP span, and reads back its trace ID, observation ID,
native Codex thread ID, and receipt digest. Repeating the command uses the
same trace identifiers. Langfuse may require sign-in to open its viewer.

By default the trace's Input shows the Crew task reference. Output shows the
recorded Codex outcome, timing, and reported token counts.

To publish the actual prompt and final response, opt in when dispatching the
handoff and when exporting its activity. Prompt capture can contain project inputs,
source, and handoff artifacts, so use a Langfuse project authorized to hold that
data. Crew stores the capture with the run in Postgres.

```sh
node bin/crew.mjs task dispatch epic-1-traced product-review --capture-activity
node bin/crew.mjs trace publish epic-1-traced product-review --include-activity
```

Follow **View activity in Langfuse** and use **Input** for the exact assignment
sent to Codex and **Output** for its exact final reply. The input-only Codex
policy permits zero agent tool calls. Build and independent QA traces include
separate child observations for the Crew runner's recorded Git and Docker
actions where applicable. Docker observations include the command, observed
stdout, stderr, exit status, and the recorded verdict. Langfuse groups these
handoff traces by Crew run session.

Historical attempts without captured activity can still publish receipt
summaries. An activity link appears only after Langfuse returns the captured
prompt and response and all expected runner observations.

## Feature requests

The local launcher can remember the destination in `.crew-local/langfuse.json`.
Use the three environment variable names above as JSON keys and store only the
URL, Langfuse project ID, and path to the private credentials file there. Setting
any connection variable in the environment selects the environment's connection.
Supply all three variables together when using this option.

To automatically publish terminal feature requests for one Crew project,
set `CREW_LANGFUSE_AUTO_PROJECT` to its exact Crew project ID alongside the
saved connection. For example, the music pilot uses `music-transcribe`.
This ID selects the source Crew project. `CREW_LANGFUSE_PROJECT_ID` selects
the destination project in the local Langfuse instance.

The worker publishes recorded call receipts when a request reaches **Completed**
or **Blocked**. Other Crew projects retain manual publication. To switch this
project back to manual publication, remove the selector or give it an empty
string. The environment can override the saved selector, including with an
empty value. An environment-supplied connection takes its selector from the
environment as well.

For manual publication, or to retry if Langfuse was unavailable when the
request finished, publish the same request's Codex call receipts again.

```sh
npm run local -- feature publish-trace lesson-replay
```

The request gets one trace. Each completed Codex call appears under it with
its role, phase, attempt, journal event number, native thread ID, measured
interval, and available model and token counts. New engineer generations show
the workspace action the engineer requested in the tree, such as
`engineer · attempt 1 · request edit · call #16`. Open the corresponding
Crew event log for the executed action and its result. On these traces, the
request span’s **Output → qaAttempts** shows each recorded QA attempt and its
check results. An empty list means Crew recorded no QA stage. New calls record the exact model
Crew requests from the CLI. An explicit profile setting takes precedence over
the CLI catalog's default. The generation’s **Model** shows the reported name
when available and otherwise the explicitly requested name. Its metadata identifies
the source as `reported` or `requested`. With Codex CLI 0.163, Crew reads the
server-reported model from Codex's response diagnostic on that call's own
process. It records the name only when the diagnostic gives one unambiguous
model for a single native thread. Crew also accepts supported model fields on
Codex’s JSON event stream. A historical receipt containing
only `codex default` leaves Model empty. Cached input and reasoning
tokens appear as subdivisions in the call output. Recordings, prompts, code,
and model replies stay out of this export. Crew uses SHA-256 digests to identify
the exact receipt set.

Crew checks the destination project first. It saves the link in the request
after reading back every expected observation, including its parent, identity,
timing, native model field, and token counters. Repeating the command reuses the verified
trace. A finished request with incomplete timing or thread identity can still
be inspected in the Crew dashboard. [Langfuse OpenTelemetry attribute mapping](https://langfuse.com/integrations/native/opentelemetry)
