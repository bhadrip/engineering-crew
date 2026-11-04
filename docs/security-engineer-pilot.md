# Security Engineer pilot

The Security Engineer answers one question about the exact candidate: what
security risk should stop release, what can wait, and what evidence is missing?
The SDM owns the fix loop. The agent receives the approved plan, candidate
diff, and available check evidence; its work product is the existing
`review-findings` array. A code review is one layer of assurance. A clean
array means no supported findings in that packet.

The [profile](../examples/hello-world/crew/security-engineer.md) holds the
role's principles. The
[review skill](../examples/hello-world/crew/skills/review-security-diff/SKILL.md)
turns them into a procedure that fits Crew's input-only runner. Research and
scoring stay outside the runtime prompt.

| Primary source | Design decision | What the fixed eval observes |
| --- | --- | --- |
| [NIST SSDF v1.1, PW.7 and PW.8](https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.800-218.pdf#page=19) distinguishes review from executable testing, and puts triage and fixes in the development workflow. [Google's Code Review Standard](https://google.github.io/eng-practices/review/reviewer/standard.html) uses evidence to resolve disagreement and distinguishes material problems from optional improvement. | Explain why a change blocks release, record deferrable hardening, and request missing evidence without claiming the check happened. | Classify the explicit CSP follow-up as backlog. Request the metrics collector's deployment or network evidence without reporting an unproven vulnerability. |
| [OWASP Secure Code Review](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html) and [Threat Modeling](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html) map changed entry points to trust boundaries. [ASVS](https://asvs.owasp.org/) supplies requirements for web controls and their verification. | Start from the approved behavior and show how a specific input, control, and operation produce an impact. A relevant API name alone cannot establish exploitability. | Trace a URL parameter into HTML execution. Clear a nearby fixed HTML literal when attacker input goes to a text sink. See [OWASP's DOM guidance](https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html). |
| [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) calls for authorization on the specific object requested. [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) identifies credentials that should be excluded from logs and separates log access from application access. | Bind storage reads to the authorized tenant or parent. Follow credentials into secondary sinks and consider who can read and reuse them. Report independent root causes separately. | Detect a cross-tenant read and a bearer token leak in the same diff. The transfer case checks a related flaw when parent authorization already exists but the child lookup is unscoped. |
| [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) covers destination validation and redirect bypass. | Follow the request past the initial allowlist; read how every redirect is handled and what data the server returns. | Block private metrics disclosure through a redirect. Clear a similar proxy when names and destination are constrained and redirects fail. |
| [OWASP Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) distinguishes untrusted content from trusted instructions and recommends permission enforcement outside the model. | Treat candidate comments as data and separate review manipulation from a product vulnerability. Use Crew's existing tool restrictions as a separate control. | Detect the actual invoice authorization bug despite a comment asking for approval. The output must not repeat the embedded override marker. |
| [PrimeVul](https://arxiv.org/abs/2403.18624) uses similar vulnerable and benign examples to expose shallow detection. [SecPRBench](https://arxiv.org/abs/2610.33509) reports that locating the right file can still mean diagnosing the wrong mechanism. | Pair close positives and negatives, then score severity, location, and mechanism instead of matching the finding title. | The offline grader checks all expected findings, flags extras, and requires grounding. The human reads outputs to catch errors the text checks miss. |

These are original, synthetic diffs that fit the current Crew packet. The two
transfer cases are kept out of the first tuning round. They are visible in the
repository and should not be treated as a hidden benchmark. The suite covers
source review for a small set of web boundaries. It does not measure repository
exploration, dependency inventory, exploit execution, or production security.
A larger follow-up should use fresh, permissioned real PRs and independently
verified outcomes. Keep those separate from the original score.

## Iteration

In the first live comparison on eight regression cases, the original profile
passed 14 of 16 runs and the first revision passed 12 of 16. The original
profile filed an unverified collector destination as a backlog finding in
both samples. The new profile handled that correctly, but two otherwise valid
findings exceeded Crew's 1,000 character limit (1,104 and 1,006). The first
revision also recorded a reviewer-directed comment as an application finding
twice. The next revision tells the agent to write two or three short evidence
sentences and to mention review manipulation in the summary. The fixtures and
rubric did not change.

The [final comparison](../evals/security-engineer/accepted.json) used
`gpt-6.1-sol` on Codex CLI 0.163.0, with two fresh runs of each case per
profile. The original profile bytes are identical at the recorded baseline
commit and at the main-branch commit in the rerun command.

| Fixed cases | Original profile | Revised profile |
| --- | ---: | ---: |
| Regression (8 cases × 2) | 15/16 | 16/16 |
| Transfer (2 cases × 2) | 3/4 | 4/4 |
| Total | 18/20 | 20/20 |

Manual inspection confirmed the revised findings and the evidence requests.
One original-profile miss was a telemetry backlog entry that should have
been an evidence request. The other was a grader false negative: the original
profile correctly described using an attachment from ticket B with permission
for ticket A, but the fixed rubric expected a word such as “another” or
“cross-ticket” in the evidence field. The rubric and recorded scores remain
unchanged. On manual review, the original profile therefore passed 19/20.
Finding IDs still varied across some repeated samples; the pilot does not
prove stable deduplication. The revised prompt used about 6% more reported
tokens across the final comparison. These results support using the skill in
the pilot, with limited evidence about general security-review performance.
