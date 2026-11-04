# Lead Engineer pilot

The Lead Engineer owns the technical recommendation and agreement on the
specific implementation plan. The first handoff gives the SDM a bounded
design and test strategy; the second says whether the submitted revision can
be built and independently verified. The Lead Engineer does not change
Product's acceptance criteria or perform the work it recommends.

The [profile](../examples/hello-world/crew/lead-engineer.md) holds the
role's principles. [Design Crew change](../examples/hello-world/crew/skills/design-crew-change/SKILL.md)
turns the brief and current behavior into a verifiable recommendation.
[Review Crew build plan](../examples/hello-world/crew/skills/review-crew-build-plan/SKILL.md)
decides whether the exact plan can proceed. Both skills are pinned by the
catalog project. They use the existing Markdown contracts and read-only
policy.

| Research and practice | Decision it changes | Eval evidence |
| --- | --- | --- |
| [GitLab's Tech Lead handbook](https://handbook.gitlab.com/handbook/engineering/careers/ic-leadership/tech-lead/) puts technical direction, guidance, and risk with the lead. [Google's account of tech leadership](https://abseil.io/resources/swe-book/html/ch05.html) describes the lead and manager as partners with distinct responsibilities. | Explain the decisive tradeoff and test, give the implementer room to choose the method, and bind approval to the received revision. | A plan with sound scope and verification can be approved even if it ignores an optional naming suggestion. |
| [Google's code review guide](https://google.github.io/eng-practices/review/reviewer/looking-for.html) asks reviewers to examine design, edge cases, complexity, and whether tests would catch a broken implementation. [DORA](https://dora.dev/capabilities/working-in-small-batches/) recommends small, independently testable changes. | Use the committed public behavior as a constraint; recommend the smallest change that meets it. Tie each material risk to a check that would distinguish the correct design from the alternative. | Test the mixed invocation that a first-token-only parser would incorrectly treat as success. Preserve the existing greeting and error behavior. |
| [Node.js process documentation](https://nodejs.org/docs/latest-v22.x/api/process.html#processexitcode) explains how immediate exit can truncate pending output. [Software Engineering at Google](https://abseil.io/resources/swe-book/html/ch12.html) favors observable behavior over internal test details. | Reason about the actual execution environment, not a small happy-path fixture. Keep author tests and an independent public-boundary oracle separate. | Require a large piped-output case. Block a plan that counts rerunning the same author test as independent QA. |
| [AWS's Builders' Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) describes ambiguous outcomes after timeouts, caller-provided request identity, and the need to record identity and mutations atomically. | Replay a committed mutation without repeating the effect. Distinguish the same logical operation from two operations with equal payloads. Do not add durable state to a read-only retry without a requirement for it. | Test lost response and restart for job creation; transfer the reasoning to a read-only retry inside one shared deadline. |
| [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html) separates compatibility expansion, migration, and removal. [Google SRE canary guidance](https://sre.google/workbook/canarying-releases/) ties controlled rollout to observable signals and a way to stop or reverse a bad change. | Evaluate the schema seen by old and new binaries during a rollout and after rollback. Preserve new writes and test the rollback path before removing compatibility. | Catch an immediate rename that breaks both live old workers and a binary-only rollback. Require mixed-version and rollback evidence. |
| [SEI's Architecture Tradeoff Analysis Method](https://www.sei.cmu.edu/library/the-architecture-tradeoff-analysis-method/) compares design choices against competing quality attributes. [AWS's decision record guide](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html) records a decision with its context and consequences. | Make the response measure and environment explicit. A small smoke test cannot establish a representative latency target; route a missing capability or scope decision to its owner. | Block a plan that claims a ten-record smoke test covers p99 at 40 concurrent requests. |

The frozen suite uses original synthetic packets. The two production task
templates are unchanged; one technical-review variant generalizes the task
objective for the synthetic scenarios while preserving its output contract.
The grader checks structured state and the downstream Markdown artifact.
It uses evidence anchors rather than matching full sentences; manual review
still checks for incorrect causal reasoning, missing decisions, or invented
authority. The suite measures scoped technical review and agreement, not
mentorship over time or performance on unseen production architectures.


A local fixture check confirmed that the legacy parser greets a single
flag-like name and rejects a mixed two-token invocation. In a separate
4 MiB piped-output check, forced exit returned status 0 after writing
65,536 bytes; graceful exit wrote all 4,194,304 bytes, including the final
newline, with empty stderr. These are fixture observations, not evidence
that an agent ran the proposed checks.

## Iteration

The first comparison used two fresh runs per regression case. The original
and first revised profiles each scored **10/12**, for different reasons.
The first revision produced two good parser recommendations but put the
missing final catalog values in the response's `blockers` field. Product
needs to settle those values before the build can be fully verified; the
technical review already had enough evidence to recommend the parser and
tests. The skill now separates review completeness from downstream
implementation gates. Both targeted reruns passed.

The original profile correctly withheld approval in both duplicate-test
cases and asked QA to author independent black-box checks. The grader's
wording anchors did not recognize those explanations; both were reviewed
as false negatives. The rubric stayed fixed.

The first full comparison scored **11/16** for the original and **12/16**
for the revision with the handoff correction. The four revised misses had
substantively sound decisions. The grader did not recognize “one database
transaction” as atomicity in the artifact, “one additional read” as one
retry, or “Product-approved” as naming the Product owner. Those were useful
clarity improvements for the receiving role: name the atomic boundary and
both outcomes, state the retry count next to the original total budget, and
use the decision owner's exact title. The frozen suite and rubric did not
change. The transfer cases were withheld from initial tuning, then exposed
during the first full comparison; they informed this last refinement.

The next run scored **15/16**. The remaining piped-output miss recommended
waiting for the write and allowing normal termination, which is sound but
did not match the grader. The skill now names the standard Node mechanism:
let pending writes drain and set `process.exitCode` when a status needs
to be set. This follows the Node documentation and the local fixture result,
without changing the case or its score.

To rerun against the original profile, use a logged-in Codex CLI and a new
output path:

```sh
node evals/run.mjs lead-engineer --model gpt-6.1-sol \
  --baseline 51de8978d8ddd0c82ce350ecd6dbbb1c60799eaf --out /tmp/lead-engineer-eval.json
```

## Accepted comparison

The [recorded comparison](../evals/lead-engineer/accepted.json) combines the
original revision 1 runs from the first full comparison with the final
revision 2 runs. Both used the same frozen suite and grading, Codex CLI
0.163.0, and `gpt-6.1-sol`, with two fresh samples per case and profile.

| Fixed cases | Revision 1 | Final revision 2 |
| --- | ---: | ---: |
| Regression (6 cases × 2) | 9/12 | 12/12 |
| Transfer (2 cases × 2) | 2/4 | 4/4 |
| Total | 11/16 | 16/16 |

Manual review credited the original profile's correctly routed
“product-owner” decision, giving **12/16** manually. The original also
correctly blocked duplicate QA in both final samples, but omitted the
specific plan revision from both downstream agreement artifacts. Two of
its completed reviews still declared blockers. The final profile resolved
those handoff issues while preserving the original's strongest technical
recommendations. The score is evidence about these packets; it is not an
estimate of general production performance.
