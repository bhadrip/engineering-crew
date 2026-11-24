import { escape } from './views.mjs';
import { buildName, featureRole } from './feature-language.mjs';
import { buildOutcome } from './feature-journey.mjs';

const reviewRoles = ['qa', 'reviewer', 'security'];
const checkNames = { qa: 'QA tests', reviewer: 'code review', security: 'security review' };
const together = new Intl.ListFormat('en', { type: 'conjunction' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const started = event => event.type === 'task.started' || event.type === 'task.resumed';
const link = (target, label) => `<a href="#${target}">${escape(label)}</a>`;
const eventTarget = (event, fallback) => positive(event?.seq) ? 'event-' + event.seq : fallback;

function planLine(events, request) {
  const planner = events.findLast(e => e.role === 'planner' && (started(e) || ['task.completed', 'task.failed'].includes(e.type)));
  if (planner?.type === 'task.failed') return `The planner ${link('stage-planning', 'stopped before handing off a plan')}.`;
  if (planner?.type === 'task.completed') {
    const plan = planner.evidence?.plan;
    if (!plan) return `The planner ${link('stage-planning', 'finished the planning stage')}.`;
    const count = key => Array.isArray(plan?.[key]) ? plan[key].filter(s => typeof s === 'string' && s.trim()).length : 0;
    const steps = count('steps'), checks = count('acceptance');
    const contents = [steps && (steps + (steps === 1 ? ' step' : ' steps')), checks && (checks + (checks === 1 ? ' check' : ' checks'))].filter(Boolean);
    return contents.length ? `The planner laid out ${link('stage-planning', together.format(contents))}.`
      : `The planner ${link('stage-planning', 'handed off the implementation plan')}.`;
  }
  if (planner) return `The planner ${link('stage-planning', 'started planning the work')}.`;
  const intake = events.find(e => e.type === 'request.started') ?? events.find(e => e.type === 'request.created');
  if (intake) {
    const handoff = intake.type === 'request.started' ? 'started the request' : 'received the request';
    return `The ${featureRole('controller')} ${link(eventTarget(intake, 'request-overview'), handoff)}.` + (request.status === 'queued' ? ' Planning is queued.' : '');
  }
  if (request.status === 'queued') return `The request is ${link('workflow', 'waiting for planning')}.`;
  return '';
}

const agents = roles => together.format(roles.map(role => role === 'qa' ? featureRole(role) : featureRole(role).toLowerCase()));
const rolesWith = (build, verdict) => build.results.filter(result => result.verdict === verdict).map(result => result.event.role);

function buildLines(events, request) {
  const attempts = Map.groupBy(events.filter(event => positive(event.attempt)), event => event.attempt);
  const builds = Array.from(attempts, ([number, history]) => buildOutcome(request, number, history)).filter(outcome => outcome.built);
  const latest = builds.at(-1);
  if (!latest) {
    const work = events.find(e => e.role === 'engineer' && positive(e.attempt) && started(e));
    return work ? [`The engineer ${link('stage-attempt-' + work.attempt, 'started implementation')}.`] : [];
  }
  const attempt = latest.build.attempt;
  const stage = 'stage-attempt-' + attempt;
  const namedBuild = link(stage, buildName(attempt));
  const count = builds.length === 1 ? 'one build' : (builds.length === 2 ? 'two' : builds.length) + ' builds';
  const story = [`The engineer produced ${link('stage-attempt-' + builds[0].build.attempt, count)} for checking.`];
  const failed = rolesWith(latest, 'Failed'), passed = rolesWith(latest, 'Passed');
  if (failed.length) {
    const allFlagged = builds.length > 1 && builds.every(build => failed.every(role => rolesWith(build, 'Failed').includes(role)));
    const affected = allFlagged ? (builds.length === 2 ? 'both builds' : 'all ' + builds.length + ' builds') : buildName(attempt);
    story.push(`The ${escape(agents(failed))} found issues in ${link(stage, affected)}.`);
  }
  if (passed.length) {
    const checks = passed.length === reviewRoles.length ? 'all three independent checks' : together.format(passed.map(role => checkNames[role]));
    story.push(`${escape(checks[0].toUpperCase() + checks.slice(1))} passed on ${namedBuild}.`);
  }
  const stopped = rolesWith(latest, 'Stopped');
  if (stopped.length) story.push(`The ${escape(agents(stopped))} stopped before returning a verdict on ${namedBuild}.`);
  const working = rolesWith(latest, 'Started');
  if (working.length && request.status === 'running' && !request.canResume && request.attempt === attempt) {
    story.push(`The ${escape(agents(working))} ${working.length === 1 ? 'is' : 'are'} still checking ${namedBuild}.`);
  }
  if (story.length === 1) story.push(latest.verified ? `The Crew controller verified ${namedBuild}.`
    : `No independent check results were recorded for ${namedBuild}.`);
  return [story.join(' ')];
}

function decisionLine(events, request) {
  const repairs = events.filter(e => e.type === 'repair.requested');
  const last = repairs.at(-1);
  const repairTarget = eventTarget(last, 'request-overview');
  const count = repairs.length === 1 ? 'one repair' : repairs.length + ' repairs';
  const stop = events.findLast(e => e.type === 'request.blocked');
  const done = events.findLast(e => e.type === 'request.completed');
  const actor = 'The ' + featureRole('controller');
  const prefix = last ? `${actor} requested ${link(repairTarget, count)} and ` : actor + ' ';
  if (stop) return prefix + link(eventTarget(stop, 'request-overview'), 'stopped before release') + '.';
  if (done) return prefix + link(eventTarget(done, 'request-overview'), 'delivered the change') + '.';
  if (last) {
    const repair = events.findLast(e => e.role === 'engineer' && e.seq > last.seq && (started(e) || e.type === 'task.completed' || e.type === 'task.failed'));
    if (request.status === 'running' && !request.canResume && repair && started(repair) && positive(repair.attempt)) {
      return `${actor} requested ${link(repairTarget, count)}. The engineer is ${link('stage-attempt-' + repair.attempt, 'working on the latest repair')}.`;
    }
    return `${actor} requested ${link(repairTarget, count)}.`;
  }
  if (request.canResume && request.status === 'running') return `The worker is ${link('request-overview', 'waiting to resume')}.`;
  if (request.status === 'blocked') return `${actor} marked the request ${link('request-overview', 'blocked')}.`;
  if (request.status === 'completed') return `${actor} marked the request ${link('request-overview', 'complete')}.`;
  return '';
}

export function featureStory(request, events = []) {
  const record = [...events].sort((a, b) => a.seq - b.seq);
  const lines = [planLine(record, request), ...buildLines(record, request), decisionLine(record, request)].filter(Boolean);
  if (!lines.length) lines.push(link('request-overview', 'Stage records are unavailable for this request') + '.');
  return `<ol class="workflow-story">${lines.map(line => '<li>' + line + '</li>').join('')}</ol>`;
}
