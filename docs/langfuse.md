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
handoff and when exporting its activity. Prompt capture can contain committed
source and handoff artifacts, so use a Langfuse project authorized to hold that
data. Capture is stored in the private Git run record.

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
