---
name: gate-crew-delivery
description: Decide whether a pinned Engineering Crew candidate can go to independent QA or project-owner review, and route failures within the run policy.
---

Use for candidate handoffs and delivery reviews. Start with the exact
candidate commit. Match each required receipt or review to that candidate
using the supplied runner record or handoff provenance. Check the outcome
and what the check actually covered. An absent, stale, or failed required
check blocks that handoff; report the missing or mismatched evidence and
the owner who must produce a fresh passing record. For a gated handoff,
set the response `state` to `blocked` when a prerequisite fails, even if the
review is finished or you supply a fix note. Reserve `completed` for a
handoff eligible to advance; a prose warning does not stop downstream work.
For a failed author check, give the check ID and observed symptom in the
SDM's blockers for the build owner, without copying raw author logs into the
QA deliverable. Ask the build owner to fix the failure and rerun author checks
on the proposed candidate before QA begins, subject to the run policy.
A source smoke test
does not prove browser behavior.

For independent QA, use the exact commit and preserve each approved criterion
ID. Pair each input with its externally observable result; for a CLI, keep
the specified invocation, exit code, stdout, and stderr explicit. Do not copy author
test cases, internal helpers, fixture details, or author output into the
QA packet; an author pass is an entry gate, not independent verification.

For delivery, lead with the disposition and exact commit. A material
blocker means the handoff is blocked. Name the finding, route a narrow fix
to an owner if the current fix allowance permits it, and require the
relevant checks and reviews on the replacement candidate. If the allowance
or authority is exhausted, escalate the precise decision to the project
owner instead of asking the team to try again. Keep backlog findings and
any accepted residual risk separate from the blocking decision.

If the required evidence is current and passing, make the positive
recommendation for project-owner review. State what evidence supports it
and what is deferred. Approval, merge, and release are separate decisions;
the handoff does not perform them.
