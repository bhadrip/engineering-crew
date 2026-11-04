---
name: crew-ux-review
description: Review Engineering Crew browser changes when they affect project or epic navigation, handoff verdicts, attempts, or evidence links. Compare user-visible claims with the crew CLI record for the same run.
---

# Review the crew UI against its records

1. Open the project and epic, then the specific handoff. Note the run ID,
   attempt, and displayed decision. Check that the project name, crew name,
   and epic title come from their own fields.
2. Read the same run with `node bin/crew.mjs --repo <checkout> run show <run>`.
   Open its input, returned output, and receipt in the browser. Compare their
   IDs, Git revisions, and attempt provenance with `artifact read`.
3. Compare the verdict to the recorded state. An agent result can be ready
   for review. A valid acceptance requires an explicit decision and evidence
   from that attempt. A Codex receipt establishes agent execution. Claim a
   test pass only when the record links the corresponding check evidence.
4. Walk the changed flow in a browser at desktop and narrow widths. If the
   change affects decisions or retries, exercise it against a disposable run
   and verify the CLI reports the browser's decision. Cover an applicable
   missing or failed evidence case. Report which states were live or seeded.
