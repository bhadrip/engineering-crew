# Langfuse drill-down

Use `crew trace publish` to send one completed Codex receipt to a local Langfuse
project. Capture is opt-in per attempt. A verified attempt shows an **Open
Langfuse trace** link under Evidence in the workflow and full handoff views.

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

The trace opens the selected observation's Preview. Input shows the Crew task
reference. Output shows the recorded Codex outcome, timing, and reported token
counts. These fields summarize the receipt. Prompts, model responses,
transcripts, tool payloads, source text, and credentials stay local. New
receipts carry Codex process timing. Older receipts use the Crew attempt
interval. The viewer links only observations verified by read-back. A failed
publication leaves the local handoff and QA results available.
