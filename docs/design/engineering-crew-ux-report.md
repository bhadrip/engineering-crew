# Engineering Crew UX Research and Recommendations

November 3, 2026 · Design proposal for the read-only V1 viewer

**Make the first screen answer three questions: What is happening? Who needs to do something? What can I verify?** Open each run to a short status summary with a direct link to the next useful thing. Keep the brief, dependency map, and full agent records close at hand. An engineer who has never seen Engineering Crew should be able to tell whether the work is ready to review and explain why.

## What the current design makes hard

The [V1 design](engineering-crew.md) defines a local, read-only viewer for a selected run. The runnable predecessor, Beaver Crew, is a useful reference for the visual design and deep links. I inspected its illustrative hints run in the browser at 1024 × 576, opened Independent verification, and checked the rendering code. This is an expert walkthrough of the predecessor, not a study with users or a live V1 run.

| What the predecessor shows | What it asks the reader to work out | Recommended change |
| --- | --- | --- |
| The brief and all three acceptance criteria fill most of the opening screen. The run says **Proposed**. | What is waiting, who owns it, and where to look next. | Put a plain-language verdict and one relevant link directly below the title. Collapse the full brief into **Original request**. |
| The home page offers **Epic & handoffs** and **Agent roster**. The overview inspector opens with **Inspect a handoff**. | Which role or handoff contains the answer. | Lead with **Overview**, **Checks**, and **Workflow**. Show the owner on the work itself. Keep the roster accessible from those names. |
| Independent verification shows expected inputs and a checklist, then **No evidence recorded**. The criteria on the home page are plain text. | Whether testing is pending, the test ran and evidence is missing, or a result failed. | Link each criterion to its verdict and receipts. Show the reason for any missing or pending result where the reader needs it. |
| Specialists are in a separate section. The graph connector code only joins nodes in neighboring rows. | Whether a specialist is optional for this run or actually blocks delivery. | Render dependencies in **Workflow**, including edges that skip rows and required specialist work. Put a text dependency alongside the graph. |

Keep the predecessor’s useful pieces: the project and task context, visible sample label, links to individual steps, and separation of inputs, outputs, and evidence. Change their order and prominence first. A different theme alone would leave the same navigation problem.

## Patterns worth borrowing

| Source | Pattern for Engineering Crew |
| --- | --- |
| [Linear’s issue delegation](https://linear.app/docs/assigning-issues) separates the accountable person from the agent doing the work and records the handoff in activity. | Use **Decision owner: project owner** and **Independent check: QA agent** where the distinction matters. Keep activity attached to the work. |
| [GitHub’s Copilot agent workflow](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/overview) connects an issue and its agent session to a pull request and human review. | Make the candidate diff and verification results the delivery handoff. Link a PR when one exists; a local diff should serve the same review purpose. |
| [Nielsen’s usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) emphasize visible state, recognizable choices, and useful recovery messages. [Microsoft’s Human-AI Interaction research](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf) recommends making capabilities clear and making correction easy. | Name the actual blocker, show who can resolve it, and put the recovery path beside it. State what the viewer can do and where decisions happen. |

These are precedents for design choices. Test whether the choices work for Engineering Crew’s users.

## The proposed first screen

Start with a quiet project bar, the task title, and a one-line goal. Below it, give the verdict the strongest visual weight: **Needs rework**, **Waiting for independent checks**, or **Ready for project review**. Pair it with one sentence of evidence and one visible link. Below that, show check results as a compact list with plain-language names and a short recent activity list. Use one accent for links and selected navigation. Reserve status colors for meaningful state and always pair them with text. Keep commit hashes, commands, and run IDs in secondary text or details.

| Recorded situation | First screen copy for the Hello World pilot | Primary link |
| --- | --- | --- |
| QA is waiting on a candidate | **Waiting for independent checks.** The crew lead must hand QA the integrated candidate. | **View candidate handoff** |
| QA reproduced a regression | **Needs rework.** QA expected invalid input to exit with status 1; it exited with 0. Delivery is waiting on the crew lead’s rework decision. | **See failed check** |
| Checks pass but a required receipt is missing | **Verification incomplete.** QA reported passing checks, but the required receipt for this candidate is missing. The crew lead owns the follow-up. | **View missing evidence** |
| Delivery review has accepted the candidate as ready for owner review | **Ready for project review.** Independent QA passed all 3 required checks on this candidate. The project owner decides whether to merge. | **Review changes** |

**Checks** answers “Did it meet the request?” Start with the criterion and observed outcome. One click shows expected versus observed behavior, who checked it, what revision they checked, and the linked receipt or a reason it is absent. Put the reproduction command and sanitized output there. Retain the history of failed attempts when a later candidate passes.

**Workflow** answers “How did we get here?” Default to a readable list of steps, their owners, and what they are waiting on. Offer the graph for diagnosing parallel work and dependencies. A side-by-side position means work *can* overlap; recorded start and end times show that it *did*. Make the graph and list link to the same step and restore context on Back.

Drive the verdict from the manifest. Keep **work state**, **check verdict**, and **evidence availability** separate. A valid receipt can prove a failure. A check that ran on an older candidate is out of date. Optional tracing being off does not block delivery; a required receipt being absent does. A completed agent attempt may still be waiting for the crew lead to accept its output. Derive “Ready for project review” from the recorded delivery disposition and current required evidence, never from an agent’s summary alone.

For first use, have the CLI or Codex workflow open the selected run directly and offer an explicitly labeled sample walkthrough before someone has a run of their own. For an invalid run bundle, show which record is invalid and how to reopen the corrected bundle. V1 links to the place that owns the decision; it does not offer browser buttons for starting agents, retrying, approving, or merging. If a decision has no destination, say who owns it and where to return, such as the originating Codex chat.

## Codex skills to use

| Skill | When I’d use it here |
| --- | --- |
| [OpenAI Product Design · audit](https://github.com/openai/plugins/blob/main/plugins/product-design/skills/audit/SKILL.md) | Use for a screenshot-based critique of the existing journey. Ask for findings tied to first visit, failed check, and evidence discovery. |
| [OpenAI Build Web Apps · frontend-app-builder](https://github.com/openai/plugins/blob/main/plugins/build-web-apps/skills/frontend-app-builder/SKILL.md) | Use to translate an agreed visual direction and supplied states into UI. Give it an explicit layout and realistic data; keep the existing stack unless the project needs a change. |
| [OpenAI Build Web Apps · frontend-testing-debugging](https://github.com/openai/plugins/blob/main/plugins/build-web-apps/skills/frontend-testing-debugging/SKILL.md) or [OpenAI Playwright Interactive](https://github.com/openai/skills/blob/main/skills/.curated/playwright-interactive/SKILL.md) | Pick one browser workflow. Verify that a reviewer can open the failed check, find the right candidate and receipt, and return to the run. Inspect the actual rendering at desktop and narrow widths. |
| [Vercel · web-design-guidelines](https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/web-design-guidelines/SKILL.md) | Optional final code audit for focus, reflow, status labels, and dead ends. The skill fetches a live checklist; review or pin the guideline revision when reproducibility matters. See the [guidelines](https://vercel.com/design/guidelines). |

Use the generic skills for design, implementation, and inspection. Put Engineering Crew’s repeatable UX rules in one short repo skill, proposed at `.agents/skills/crew-ux-review/SKILL.md`. Trigger it for changes to the viewer, status copy, checks, or evidence navigation. Have it open representative runs, check the verdict against the records, walk the failed-check and review paths, and record viewport and keyboard findings. Use [Codex’s documented repo skill location](https://learn.chatgpt.com/docs/build-skills) and [OpenAI’s skill eval approach](https://developers.openai.com/blog/eval-skills) to check both when the skill activates and what it actually verifies. The upstream skills above were inspected and shortlisted; they were not installed or tested against this repo.

## What to build and how to tell it works

1. **Prototype one run in three states:** waiting on QA, a verified failure, and ready for project review. Include a missing required receipt in the evidence drill-down. Use clearly labeled fixtures; connect the same views to real pilot records next.
2. **Observe five people unfamiliar with the project**, including someone delegating work and someone reviewing code. Without docs or a tour, ask them whether they can review the change, who owns the next action, and what output proves that a regression happened. Record first click, time to answer, wrong conclusions, and requests for help. Suggested first-round target: at least four of five answer status and ownership correctly in 30 seconds and find the matching receipt within 60 seconds, with zero mistaking the failing or stale candidate for ready. This is a pilot threshold, not a population estimate. Repeat with new people after fixing recurring confusion. [GOV.UK’s moderated testing guide](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing) explains how to write neutral tasks and observe without coaching.
3. **Check accessibility on the same paths.** Target [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/). Verify keyboard-only navigation, visible and unobscured focus, narrow reflow, meaningful link names, and screen reader access to status and evidence. If the viewer updates in place, [announce important status changes without moving focus](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html). Use [Playwright and axe](https://playwright.dev/docs/accessibility-testing) for automated coverage, then manually walk the paths.
