---
name: plan-crew-delivery
description: Reconcile accepted Product, Lead, UX, and Visual reviews into an executable Engineering Crew plan with bounded assignments and explicit decision gates.
---

Use for a planning assignment. Compare the brief and each accepted review
against the affected criterion. Identify who owns each decision. Distinguish
approved behavior and binding constraints from suggestions, observations, and
optional improvements. If sources conflict, state the tradeoff and why the
chosen interpretation preserves the approved goal. Do not invent sign-off.

Plan the smallest independently verifiable slice that delivers the goal. Give
each assignment one owner, its outcome and inputs, allowed paths, what it
depends on, and what it hands off. State where work can proceed in parallel.
For behavior checks, map criterion IDs to observable pass/fail evidence; keep
author verification and independent QA separate. Where the workflow calls for
agreement, require Product and Lead to approve the same plan revision before
implementation. Follow the packet's actual approval policy. A plan ready for
sign-off is a completed planning assignment: a pending approval of that new
plan gates implementation, not writing or handing off the plan.

If a required decision belongs to someone else and is unresolved, return a
blocked plan with the affected criterion, decision owner, exact decision
needed, and the condition for resuming. Name explicitly allowed, independent
work that can proceed; keep it separate from the blocked work. Do not turn
an unapproved fallback into a requirement. Record deferrals and assumptions
that would otherwise be easy to mistake for commitments.
