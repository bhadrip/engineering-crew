# Developing and evaluating a Crew agent

A profile owns a work product and a bounded decision. A skill teaches the
judgment or procedure that improves that work. The eval measures observable
behavior on the same work product before and after a change. The [Security
Engineer pilot](security-engineer-pilot.md), [SDM pilot](sdm-pilot.md), and
[Lead Engineer pilot](lead-engineer-pilot.md) show how this works for reviews,
delivery decisions, and technical plan approval.

Keep static prompts and skills in Git. Place new role-specific skills under
`skills/<agent-id>/` and reusable ones under `skills/common/`. Each agent's
profile lists the skills it uses. Register a new project configuration
version to activate a revised profile or skill for future runs.

1. **Define the job.** Name the decision the role owns, the packet it gets,
   the output the next role needs, and the boundary of its authority. For
   example, a reviewer identifies release blockers and supplies evidence;
   the SDM decides when to send the candidate back. Start with one existing
   profile and record its Git commit and revision.
2. **Research the judgment.** Read primary standards, the documentation for
   relevant tooling, and original studies. Write down what changes an agent's
   decisions and what would prove it did a better job. Keep this rationale in
   a research note. Use the profile for enduring beliefs and the skill for
   decision rules. Add a script when it makes a repeatable action more reliable.
3. **Freeze the assessment before iterating.** Put realistic assignments in
   `evals/<role>/v1/cases.json`, the task templates in `task.json`, and ground
   truth and scoring in `rubric.json` and `grade.mjs`. Use the same output
   contract as production. Include real failures, safe look-alikes, competing
   requirements, missing evidence, and at least one novel scenario kept out
   of the first tuning pass. Prefer verified outcomes (process assertions,
   tests, or evidence) to exact phrasing. Test the grader with correct and
   deliberately wrong responses. Freeze the task, cases, rubric, and grader
   together with a SHA-256 lock.
4. **Change one thing and compare.** Load the old profile from Git and the
   proposed profile from disk. Keep the model, runner, fixtures, and grading
   the same. Run repeated samples in fresh sessions. Read the actual outputs,
   especially disagreements: distinguish a missed behavior from a faulty
   grader, a bad fixture, and a runtime failure. Fix the smallest problem
   supported by evidence. Reserve the transfer cases for the final comparison;
   they are withheld during tuning, not a secret benchmark.
5. **Activate with evidence.** Bump the profile revision and register each
   skill with the cases that exercise its rules in `evals/registry.json`.
   Use `alsoProjects` for projects with the identical profile and compatible
   model so that one benchmark covers the shared profile.
   Use the live runner to record a two-sample baseline and candidate for every
   case, including transfer. Review the artifacts for meaningful correctness;
   a keyword match can miss wrong reasoning. Store only synthetic or approved
   shareable output in the repo. Keep prior benchmark versions and write any
   revised cases, task, or rubric under a new version. If extending a suite,
   rerun both variants on the new suite and report that comparison separately.

The harness uses the same input-only Codex adapter and response contract as
Crew dispatch. It never sends the rubric or case labels. For a role with
multiple handoff types, put a `tasks` map in `task.json`. Each case picks a
`task` key and supplies ordered `artifacts` as `[id, title, kind, content]`
tuples; use the production task templates and representative input evidence.
The original security suite's single-task format is still supported. For QA
or implementation, execute the returned checks or patches on isolated
fixtures and score observed behavior. No live services should be needed by
a fixture.

Use this outline for the next role:

| Design input | Write down |
| --- | --- |
| Profile | “Given [packet], own [decision] and return [handoff]. Escalate when [missing authority or evidence].” |
| Research note | Source, finding, what decision it changes, and the case that tests that decision. |
| Skill | Trigger, judgment steps, evidence required for each outcome, and any handoff limits. |
| Case | Realistic brief and minimal raw evidence, a human-verifiable expected outcome, and a plausible wrong outcome to reject. |
| Acceptance record | Old and new profile revisions, fixed suite digest, model and CLI, raw outcomes, misses, and remaining uncertainty. |

For an SDM, a case might test whether the plan sequences a blocked dependency
and names a decision owner. For a lead engineer, test a design whose happy
path works but whose failure recovery violates an explicit requirement. For
an implementer or QA agent, use passing and failing variants so the grader
can verify a change or check against an independent oracle.

To create a lock for a **new** suite, from its directory run:

```sh
node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const sources = ["task.json", "cases.json", "rubric.json", "grade.mjs"].map(f => readFileSync(f, "utf8"));
const digest = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
writeFileSync("lock.json", JSON.stringify({ digest }, null, 2) + "\n", { flag: "wx" });'
```

To rerun the pilot, use a logged-in Codex CLI, an explicit model, and a new
output path. Omit `--split` for a single report covering both splits. You can
also use `--case <id> --samples 1` when diagnosing a single result. Local
runs use up to four independent sessions at once, with no automatic retry.

```sh
node evals/run.mjs security-engineer --model gpt-6.1-sol \
  --baseline 6de4b2f98c803ef86c0583cb8c7a35810e74d935 --out /tmp/security-eval.json
npm test
npm run eval:check -- --base <branch-base>
```

Tests regrade the recorded raw responses, verify suite and profile digests,
and reject missing skill coverage or incomplete acceptance reports. The PR
check also compares frozen suites with the base branch, even if someone updates
a lock, and requires a revised profile to be compared against its prior
version. The offline check verifies the consistency of checked-in evidence;
it is not an attestation that a particular model served a response. Rerun live
when changing a profile, skill, model, or runner. A model alias and CLI version
make the comparison interpretable; they cannot make model output deterministic.
