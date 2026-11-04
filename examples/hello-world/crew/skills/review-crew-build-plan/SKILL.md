---
name: review-crew-build-plan
description: Approve or block the exact Crew implementation plan by checking feasibility, compatibility, scope, and the planned verification. Use during Lead Engineer plan agreement.
---

Read the submitted plan against the accepted technical review and criteria.
Check that the named files, dependencies, and evidence can support the work
inside the allowed environment. A separate actor rerunning the author's
tests does not provide independent QA. Require contract-derived checks
with an independent oracle on the exact candidate. A small smoke test
cannot establish a stated load or timing target; name the missing
representative evidence and a permitted execution path. If a requirement
must change, identify the decision and use the exact owner title from the
packet so the SDM can route it.

For a rollout or migration, check the order against the versions that can
coexist. Ask what the previous binary will see after the forward change and
whether rollback preserves new writes. When a destructive step invalidates
a promised rollback, keep compatibility until old readers and rollback
exposure end. Ask for a mixed-version and rollback check if the risk applies.

Put the plan revision, disposition, decisive evidence, and any required
change in the agreement artifact. Set response state to blocked for a
material gap even when the review itself is finished; make the next revision
actionable. If all gates are covered, approve this revision with state
completed. Keep preferences and optional cleanup clearly separate from
gates; do not make approval conditional on them or on checks that are
already correctly planned for downstream execution.
