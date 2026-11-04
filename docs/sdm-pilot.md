# Software Development Manager pilot

Crew's SDM coordinates delivery across specialists. It turns accepted
requirements into a plan people can execute, then sends the exact candidate
to the next decision maker only when the relevant evidence supports it.
Project owners keep approval, merge, and release authority. People management
research informs how the agent communicates and delegates; the pilot does
not measure hiring, coaching people over time, or team performance.

The [profile](../examples/hello-world/crew/sdm.md) holds the role's beliefs.
[Plan Crew delivery](../examples/hello-world/crew/skills/plan-crew-delivery/SKILL.md)
covers scope, dependencies, approval, and verification before implementation.
[Gate Crew delivery](../examples/hello-world/crew/skills/gate-crew-delivery/SKILL.md)
covers the independent QA handoff, bounded rework, and owner review. Both Pet
Store epics use the same profile and skills. Task permissions and approval
authority are unchanged.

| Research and practice | How it changes the agent | What the eval measures |
| --- | --- | --- |
| [Google Project Oxygen and Aristotle](https://rework.withgoogle.com/intl/en/guides/following-the-data-the-research-behind-great-managers) emphasize effective communication, clear goals, collaboration, and delegation. [Edmondson's field study](https://web.mit.edu/curhan/www/docs/Articles/15341_Readings/Organizational_Learning_and_Change/Edmondson_1999_Psychological_safety.pdf) links psychological safety to learning behavior. | State the outcome and evidence a specialist owns. Surface disagreement and what is uncertain rather than claiming consensus. Give each open decision an owner. | Preserve Product's approved exit code over a skeleton observation. Identify the privacy decision and the work that can proceed independently. |
| [GitLab's engineering DRI practice](https://handbook.gitlab.com/handbook/engineering/development/growth/engineering_dri/) assigns delivery responsibility without requiring that person to execute every task. Its [architecture workflow](https://handbook.gitlab.com/handbook/engineering/architecture/workflow/) distinguishes consultation from blocking authority. | Reconcile inputs without treating every suggestion as a requirement. Use the stated approval policy and escalate decisions that belong to another owner. | Preserve Product and Lead sign-off on one plan revision. Route the unresolved display decision to Privacy, and leave scope changes beyond the fix limit to the project owner. |
| [DORA's small-batch](https://dora.dev/capabilities/working-in-small-batches/) and [test-automation](https://dora.dev/capabilities/test-automation/) guidance connects small, testable work to faster feedback. | Keep a slice small enough to verify, give it bounded paths, and make the evidence for each acceptance criterion observable. Preserve independent QA in the Crew workflow. | Defer the cache, retain existing CLI behavior and distinct QA, and hand QA a black-box scope with no author oracle. |
| [SLSA artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts) binds provenance to an artifact's digest. [Google SRE release engineering](https://sre.google/sre-book/release-engineering/) connects release decisions to reproducible artifacts and evidence. Crew applies the artifact identity principle to its own receipts; this is not SLSA attestation. | Check both candidate identity and the actual result; keep author, independent, and browser evidence distinct. | Compare a matching pass, a stale pass, and a matching failure. A clean delivery must cite matching browser evidence, not infer it from source smoke. |
| [Google SRE canary guidance](https://sre.google/workbook/canarying-releases/) recommends evaluating risk against limited exposure and explicit signals. Its [postmortem guidance](https://sre.google/workbook/postmortem-culture/) focuses follow-ups on causes, concrete actions, and owners. | State the disposition up front. Route a narrow fix with evidence when allowed, and escalate when scope, spend, or fix allowance is exhausted. | Keep the keyboard blocker separate from card-spacing backlog; ask for the browser check and repeat reviews on a replacement. Escalate when zero loops remain. |

The frozen suite uses four existing Markdown output contracts and eight
original synthetic packets, including two withheld from the first tuning
round. The release cases test the SDM's judgment if it receives a review with
a blocker. In the current workflow, blockers gate delivery and the run's
decision owner requests fixes through the CLI or UI. The eval does not grant
the SDM tools, waive a gate, or change who can request a fix loop. The grader
checks the response contract, disposition, commit identifiers, evidence
anchors, and leakage. Raw outputs are also reviewed for whether they really
support the claimed decision.

## Iteration

The first live comparison on the six regression cases scored **7/12** for
revision 2 and **9/12** for the first version of revision 3. Revision 2
described the privacy and keyboard blockers in prose, but reported the
assignment completed in both samples of each case. That distinction matters:
the next handoff uses the structured state. Revision 3 correctly blocked
those handoffs but overcorrected when the plan itself was ready and only its
downstream sign-off was pending. The revised planning skill separates those
two gates. Both targeted reruns produced a completed plan with sign-off still
required before implementation.

One first-round QA handoff correctly said “Exit status is 2,” which the fixed
grader did not recognize. The rubric was retained as published for this
comparison. The QA skill now explicitly calls for a criterion ID, invocation,
exit code, and separate output expectations wherever the accepted criteria
specify them. The baseline's stale receipt miss also merits context: it
identified the mismatch and asked the author for candidate-bound evidence,
but did not explicitly ask for a new passing run.

The first full comparison scored **8/16** for revision 2 and **12/16** for
the then-current revision 3. Two revised delivery outputs described a
blocker but returned `completed`. Both revised failed-receipt outputs blocked
QA and requested passing evidence, but omitted the observed failure that the
build owner needed. The final gate skill explicitly sets the structured state
on a failed handoff and asks for the check ID and observed symptom in the
SDM's blockers. It keeps raw author output out of the QA deliverable.

To rerun against the original profile, use a logged-in Codex CLI and a new
output path:

```sh
node evals/run.mjs sdm --model gpt-6.1-sol \
  --baseline 4f85e4a02208ba5321ab38a8cdedfd0722ded7e5 --out /tmp/sdm-eval.json
```

## Accepted comparison

The [recorded comparison](../evals/sdm/accepted.json) combines the original
revision 2 runs from the first full comparison with the final revision 3
runs. Both use the same frozen task packets and rubric, Codex CLI 0.163.0,
and `gpt-6.1-sol`, with two fresh samples per case and profile.

| Fixed cases | Revision 2 | Final revision 3 |
| --- | ---: | ---: |
| Regression (6 cases × 2) | 6/12 | 12/12 |
| Transfer (2 cases × 2) | 2/4 | 4/4 |
| Total | 8/16 | 16/16 |

Manual inspection confirmed that the final revision held the privacy and
candidate gates, kept the clean QA handoffs independent, and stopped rework
when the allowance was exhausted. Several baseline misses were narrower than
the score suggests: both stale-receipt outputs correctly withheld QA and
requested matching evidence, though they omitted an explicit fresh run;
one failed-receipt output gave the symptom and asked for a successful
receipt but did not explicitly say to rerun the check. The fixed grader
remains unchanged. The transfer cases were withheld during the first tuning
round, then exposed during the first full comparison; they informed the
final failed-receipt refinement and are no longer unseen.

The shared runner now accepts different production task and artifact shapes
in one suite. Its change was checked against the unchanged Security Engineer
suite: the existing security profile passed [20/20 on the updated runner](../evals/security-engineer/shared-runner.json).
