---
name: design-crew-change
description: Recommend the smallest testable technical approach for a Crew brief using the supplied source and author tests. Use during Lead Engineer technical review.
---

Read the brief, committed source, and tests together. Identify the public
behavior to add and the behavior that must survive. Trace the controlling
branch or interface from input to output; distinguish what the source shows
from what still needs execution. For a CLI, check argument count and precedence,
stdout and stderr separately, exit status, and output completeness under the
specified I/O conditions. In a Node CLI with pending stdout or stderr
writes, explain why immediate `process.exit()` can truncate a pipe.
Prefer draining writes and natural exit; set `process.exitCode` when a
specific status is required.

Recommend the smallest approach inside the authorized paths. When a plausible
alternative changes a material tradeoff, name the benefit, the requirement
it threatens, and why the recommended option fits. Defer unneeded
abstractions or dependencies. An actual constraint conflict needs a decision
from its owner, not an invented requirement or an unauthorized extra file.

A technical review is complete when you can hand off an actionable
recommendation. Record rejected options, implementation constraints, and
future acceptance checks in the technical review artifact. Use the result's
blockers field only when something prevents you from completing this review,
not for constraints an implementer must honor in a later task.

Walk through the relevant failure that could invalidate the design. When
the design involves retries, distinguish reads from mutations. For a retried
mutation, consider success with a lost response, restart, and concurrent
replay. Preserve intent with a stable operation identifier. Name the
atomic boundary in the recommendation: the durable request record and effect
must commit together or neither should persist. Equal payloads need not be
the same operation. For a side-effect-free read, do not add durable
deduplication merely because it retries. State the maximum retry count and
the original total time budget together in the artifact, and preserve
terminal errors unless the contract says otherwise.

Map each risk to an observable check: input or fault, expected result,
and environment or evidence needed. Put focused checks near the changed
code and give independent QA its own contract-derived oracle at the public
boundary. Include a discriminating negative or compatibility case that would
fail if the risky alternative were used. Do not claim tests ran.
