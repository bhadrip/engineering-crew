import assert from 'node:assert/strict';
import test from 'node:test';
import { featureAgentHref, featureAgentsPage, featureInputHref, featureInputPage } from '../ui/feature-agents.mjs';
import { featurePrompt, rolePromptTemplate } from '../lib/feature-prompts.mjs';
import { resolveRoleProfiles } from '../lib/feature-profiles.mjs';

const project = { id: 'song', name: 'Music', featureOnly: true };
const profiles = resolveRoleProfiles({ qa: { id: 'qa-local', instructions: 'Check <meter>.' } }, { agentImage: 'node:22-alpine' });
const event = (seq, type, attempt, evidence = {}) => ({seq, type, role:'qa', attempt, operationId:'request:qa:' + attempt, evidence});
const record = {id:'request', events:[]};
const oldProfile = {...profiles.qa, instructions:'Old <rhythm> rule.', digest:'abc123', model:'old-model'};
const call = {profileDigest:'abc123', callId:'call-1', threadId:'turn-1', startedAt:'2026-11-24T00:00:00Z',
  endedAt:'2026-11-24T00:00:03Z', model:'old-model', inputDigest:'input-id', outputDigest:'output-id'};
const request = {...record, events:[
  event(1,'runtime.profile',1,oldProfile), event(2,'runtime.started',1,{profileDigest:'abc123',image:'sha256:worker'}),
  event(3,'agent.started',1,{...call,outputDigest:null}), event(4,'agent.completed',1,call),
  event(5,'task.completed',1,{receipt:call,passed:false,summary:'Wrote the test.',checks:[{passed:false,check:'Independent QA tests',error:'Expected a timestamp.'}]}),
  event(6,'runtime.profile',2,{...oldProfile,id:'repair-qa',digest:'repair-profile',instructions:'Repair instructions.'}),
  event(7,'agent.started',2,{callId:'pending-call',inputDigest:'new-input'}), event(8,'tool.completed',2,{action:'list'}),
]};

test('current agent roster and role details share the actual runtime prompt with the operator', () => {
  const roster = featureAgentsPage(project,{profiles});
  for(const role of Object.keys(profiles)) assert.ok(roster.includes(featureAgentHref(project,role)));
  assert.doesNotMatch(roster,/Return exactly one action|Check &lt;meter&gt;/);
  assert.match(featureAgentHref({...project,featureOnly:false},'qa'), /\/feature-agents\?role=qa$/);
  const qa = featureAgentsPage(project,{profiles,role:'qa'});
  assert.match(qa, /Check &lt;meter&gt;\./);
  assert.match(qa, /Prepared or run by Crew/);
  assert.ok(qa.includes(rolePromptTemplate('qa').role));
  const engineer = featureAgentsPage(project,{profiles,role:'engineer',developmentProbe:true});
  assert.match(engineer,/Actions the engineer can request/);
  assert.match(engineer,/operator development fixture/);
  assert.doesNotMatch(featureAgentsPage(project,{profiles,role:'engineer'}),/operator development fixture/);
  const payload = {goal:'Run & verify'};
  for (const role of Object.keys(profiles)) {
    const t=rolePromptTemplate(role);
    assert.equal(featurePrompt(role,profiles[role].instructions,payload), t.shared + t.role + '\nOperator role instructions: ' +
      profiles[role].instructions + '\nApplication contract: ' + t.contract + '\n' + JSON.stringify(payload));
  }
});

test('historical profiles and calls preserve attempt, source, verdict and exact-content links', () => {
  const first = featureAgentsPage(project,{role:'qa',request,attempt:1,profiles});
  assert.match(first,/Old &lt;rhythm&gt; rule/);
  assert.match(first,/abc123/);
  assert.match(first,/sha256:worker/);
  assert.match(first,/Expected a timestamp/);
  assert.doesNotMatch(first,/Repair instructions|Check &lt;meter&gt;|Call #3/);
  assert.match(first,/Call #4/);
  assert.ok(first.includes(featureInputHref(project,'request',4)+'#agent-output'));
  assert.ok(first.includes(featureInputHref(project,'request',4)+'#exact-input'));
  assert.match(first,/event-5/);
  const later = featureAgentsPage(project,{role:'qa',request,attempt:2,profiles});
  assert.match(later,/Repair instructions/);
  assert.match(later,/Start record · No linked completion/);
  assert.match(later,/events\/7\/input#exact-input/);
  assert.doesNotMatch(later,/events\/7\/input#agent-output|Old &lt;rhythm&gt; rule/);
  assert.match(featureAgentHref(project,'planner',{requestId:'request',attempt:0}), /role=planner&attempt=0$/);
});

test('legacy starts use an actual matching timestamp or a causal chain, and retain observed harness settings', () => {
  const old = {...record,events:[
    {...event(1,'agent.started',2,{harness:'codex',sandbox:'read-only'}),at:'2020-01-01T00:00:00Z'},
    event(2,'agent.completed',2,{startedAt:'2020-01-01T00:00:00Z'}),
    event(3,'agent.started',2,{}),
    {...event(4,'agent.thread',2,{threadId:'native-2'}),parents:[3]},
    {...event(5,'agent.completed',2,{threadId:'native-2'}),parents:[4]},
    event(6,'agent.started',2,{}),event(7,'agent.completed',2,{threadId:'native-3'}),
    event(8,'task.completed',2,{passed:false,revision:'abc',findings:['Missing expected check.']}),
    event(9,'agent.started',2,{startedAt:'shared-clock'}),event(10,'agent.started',2,{startedAt:'shared-clock'}),
    event(11,'agent.completed',2,{startedAt:'shared-clock'}),
  ]};
  const page=featureAgentsPage(project,{role:'qa',request:old});
  assert.doesNotMatch(page,/Call #(?:1|3)\b/);
  assert.match(page,/Call #6/);
  assert.match(page,/Call #9/);
  assert.match(page,/Call #10/);
  assert.match(page,/No linked completion/);
  assert.match(page,/Codex sandbox<\/dt><dd>read-only/);
  assert.match(page,/Harness<\/dt><dd>codex/);
  assert.match(page,/Run QA tests for repair 1 · Failed/);
  assert.doesNotMatch(page,/Changes requested/);
});

test('missing historical capture keeps a recorded digest and never reconstructs old content', () => {
  const old = {...record,events:[event(2,'task.completed',1,{receipt:{profileId:'old-qa',profileDigest:'only-digest'}})]};
  const page = featureAgentsPage(project,{request:old,role:'qa',profiles});
  assert.match(page,/only-digest/);
  assert.match(page,/did not save a full role profile/);
  assert.match(page,/Exact call content unavailable/);
  assert.doesNotMatch(page,/Check &lt;meter&gt;|independent node:test acceptance test module/);
  const missing = featureInputPage(project,old,old.events[0],null,null);
  assert.match(missing,/exact prompt and launch settings were not saved/);
  assert.match(missing,/No exact response was saved/);
});

test('exact call page displays escaped payloads on demand and preserves the controller role boundary', () => {
  const page = featureInputPage(project,request,request.events[2],{
    digest:'input-id', promptSha256:'hash', prompt:'System and data\n</pre><script>bad()</script>',
    config:{harness:'codex',profileId:'old-qa',profileInstructions:'Check this.',profileDigest:'abc123',
      agentActions:[],nativeTools:[],controllerActions:['read','independent-tests'],sandbox:'read-only',requestedModel:'old-model',
      disabledFeatures:['shell_tool','web_search'],outputSchema:{type:'object'}}},
    {digest:'output-id',raw:JSON.stringify({summary:'Check documented behavior.',testSource:'<test>\npass'})});
  assert.match(page,/Check documented behavior\./);
  assert.match(page,/Read files · Run independent tests/);
  assert.match(page,/Agent actions<\/dt><dd>None/);
  assert.match(page,/&lt;test&gt;/);
  assert.match(page,/&lt;\/pre&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(page,/<script>bad\(\)/);
  assert.match(page,/Codex call receipt/);
  assert.match(page,/Run QA tests for the first build · Failed/);
  assert.match(page,/Expected a timestamp/);
  assert.match(page,/id="exact-input"/);
  assert.match(page,/id="agent-output"/);
  assert.ok(page.includes('/requests/request/agents?role=qa&amp;attempt=1'));
});

test('historical role results link to the exact workflow stage and recognize stale or superseded evidence', () => {
  const earlier = event(11,'task.completed',2,{passed:true,revision:'old'});
  const next = event(12,'task.completed',2,{passed:true,revision:'old'});
  const owner = {...event(9,'task.completed',2,{revision:'current'}),role:'engineer'};
  const page = featureAgentsPage(project,{request:{...record,events:[owner,earlier,next]},role:'qa',attempt:2});
  assert.match(page,/Run QA tests for repair 1 · Earlier record/);
  assert.match(page,/Run QA tests for repair 1 · Different build/);
  assert.match(page,/requests\/request#stage-qa-2/);
  assert.doesNotMatch(page,/Run QA tests for repair 1 · Passed/);
});

test('the current definition distinguishes a role override, a Crew default and a Codex default', () => {
  const options = { profiles, role:'qa', catalog:{ defaultModel:'codex-model', models:['codex-model','another-model'] },
    definitions:{ qa:{ revision:'current', model:'', instructions:'Check <meter>.' } } };
  const page = featureAgentsPage(project, options);
  assert.match(page, /<strong>codex-model<\/strong><span>Codex default<\/span>/);
  assert.match(page, /method="post" action="\/projects\/song\/agents\?role=qa"/);
  assert.match(page, /name="version" value="current"/);
  assert.match(page, /name="model"[^>]+list="available-models"[^>]+value=""/);
  assert.match(page, /<option value="another-model">/);
  assert.match(page, /name="instructions"[^>]*>\nCheck &lt;meter&gt;\.<\/textarea>/);
  assert.match(featureAgentsPage(project, { ...options, role:null }), /<small>codex-model<\/small>/);
  assert.match(featureAgentsPage(project, { ...options, catalog:null }), /<strong>Selected at launch<\/strong><span>Codex default<\/span>/);
  const crew = { ...options, defaultModel:'crew-model', profiles:{ qa:{ ...profiles.qa, model:'crew-model' } } };
  const inherited = featureAgentsPage(project, crew);
  assert.match(inherited, /<strong>crew-model<\/strong><span>Crew default<\/span>/);
  assert.match(inherited, /Leave empty to use the Crew default, crew-model\./);
  assert.match(inherited, /name="model"[^>]+value=""/);
  const pinned = featureAgentsPage({...project,featureOnly:false}, { ...crew, profiles:{ qa:{ ...profiles.qa,model:'role-model' } },
    definitions:{ qa:{ ...options.definitions.qa, model:'role-model' } }, saved:true });
  assert.match(pinned, /<strong>role-model<\/strong><span>Role override<\/span>/);
  assert.match(pinned, /name="model"[^>]+value="role-model"/);
  assert.match(pinned, /action="\/projects\/song\/feature-agents\?role=qa"/);
  assert.match(pinned, /role="status">Definition saved/);
});

test('a rejected edit retains the submitted revision and values while request history remains read-only', () => {
  const options = { profiles, role:'qa', definitions:{ qa:{ revision:'newer', model:'', instructions:'Saved text' } },
    editorError:'Another editor saved this role.', draft:{ version:'old', model:'bad" value', instructions:'</textarea>\nKeep' } };
  const html = featureAgentsPage(project, options);
  assert.match(html, /class="agent-editor" open/);
  assert.match(html, /role="alert">Another editor saved this role/);
  assert.match(html, /href="\/projects\/song\/agents\?role=qa">Reload saved definition/);
  assert.match(html, /name="version" value="old"/);
  assert.match(html, /value="bad&quot; value"/);
  assert.match(html, /&lt;\/textarea&gt;\nKeep<\/textarea>/);
  const historical = featureAgentsPage(project, { ...options, request, saved:true });
  assert.doesNotMatch(historical, /Edit definition|Save changes|role-model|Definition saved|Another editor|bad&quot; value/);
});
