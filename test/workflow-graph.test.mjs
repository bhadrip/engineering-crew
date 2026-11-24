import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../ui/workflow-graph.js', import.meta.url), 'utf8');
const dependencyEditor = await readFile(new URL('../ui/workflow-dependency-editor.js', import.meta.url), 'utf8');

function element(left = 0, top = 0, width = 0, height = 0) {
  const listeners = new Map();
  return {
    getBoundingClientRect: () => ({ left: left + 100, right: left + width + 100,
      top: top + 200, bottom: top + height + 200, width, height }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    fire: type => listeners.get(type)?.(),
    setAttribute(name, value) { this[name] = value; },
  };
}
function card(key, left, top, width) {
  const summary = element(left, top, width, 40), body = element();
  return { dataset: { key }, summary, body, open: false,
    querySelector: selector => selector.endsWith('summary') ? summary : body };
}
function mount(rows, pairs, dockedPairs = [], options) {
  const group = { replaceChildren(...nodes) { this.nodes = nodes; } };
  const svg = element(0, 0, 360, 500);
  svg.querySelector = () => group;
  const canvas = element();
  canvas.querySelector = () => svg;
  const levels = rows.map(row => ({ querySelectorAll: selector => selector === (options?.nodeSelector ?? 'details.workflow-step[data-key]') ? row : [] }));
  const dependencyLinks = entries => entries.map(([from, to]) => ({ dataset: { from, to } }));
  canvas.querySelectorAll = selector => selector === '.workflow-level' ? levels : dependencyLinks(pairs);
  const window = element(), fonts = element(), callbacks = new Map();
  let frame = 0, observer;
  class Observer {
    constructor(notify) { this.notify = notify; observer = this; this.elements = new Set(); }
    observe(node) { this.elements.add(node); }
    disconnect() { this.elements.clear(); }
  }
  const context = vm.createContext({ window, document: { fonts, createElementNS: () => element() }, ResizeObserver: Observer,
    requestAnimationFrame(fn) { callbacks.set(++frame, fn); return frame; }, cancelAnimationFrame: id => callbacks.delete(id) });
  vm.runInContext(script, context);
  const monitor = dockedPairs.length ? { querySelectorAll: () => dependencyLinks([...pairs, ...dockedPairs]) } : undefined;
  const dispose = context.connectWorkflowGraph(canvas, monitor, options);
  const flush = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const fn of pending) fn();
  };
  flush();
  const paths = () => new Map(group.nodes.map(p => [p['data-from'] + '>' + p['data-to'], p.d]));
  return { canvas, paths, callbacks, svg, window, fonts, flush, dispose, observer };
}

test('editable graph connectors use the step buttons and the editor arrow marker', () => {
  const make = (key, top) => ({
    dataset: { key }, querySelector: selector => selector === ':scope > button' ? element(130, top, 100, 40) : null,
  });
  const graph = mount([[make('plan', 0)], [make('review', 80)]], [['plan', 'review']], [], {
    nodeSelector: '[data-dependency-node]', portSelector: ':scope > button', markerId: 'workflow-editor-arrow',
  });
  assert.equal(graph.paths().get('plan>review'), 'M180 40 V80');
  assert.equal(graph.svg.querySelector().nodes[0]['marker-end'], 'url(#workflow-editor-arrow)');
  graph.dispose();
});

test('dependency editing rejects back edges through branches and leaves unrelated steps available', () => {
  const context = vm.createContext({});
  vm.runInContext(dependencyEditor, context);
  const steps = new Map([
    ['plan', { parents: [] }], ['implement', { parents: ['plan'] }], ['test', { parents: ['implement'] }],
    ['review', { parents: ['implement', 'test'] }], ['rubric', { parents: [] }],
  ]);
  assert.equal(context.closesWorkflowCycle(steps, 'review', 'plan'), true);
  assert.equal(context.closesWorkflowCycle(steps, 'test', 'implement'), true);
  assert.equal(context.closesWorkflowCycle(steps, 'rubric', 'review'), false);
  assert.equal(context.closesWorkflowCycle(steps, 'plan', 'review'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.workflowDependencyRanks(steps))), {
    ranks: [['plan', 'rubric'], ['implement'], ['test'], ['review']], remaining: [],
  });
  steps.get('plan').parents.push('review');
  assert.deepEqual(JSON.parse(JSON.stringify(context.workflowDependencyRanks(steps))), {
    ranks: [['rubric']], remaining: ['plan', 'implement', 'test', 'review'],
  });
});

test('switching back to the DAG includes dependencies in the open inspector', () => {
  const build = card('build', 130, 0, 100), qa = card('qa', 130, 80, 100);
  const graph = mount([[build], [qa]], [], [['build', 'qa']]);
  assert.equal(graph.paths().get('build>qa'), 'M180 40 V80');
  graph.dispose();
});

test('wire endpoints use visible card centers and only recorded, deduplicated dependencies', () => {
  const build = card('build', 130, 0, 100);
  const qa = card('qa', 14, 80, 100), code = card('code', 130, 80, 100), security = card('security', 246, 80, 100);
  const decision = card('retry', 130, 160, 100);
  const graph = mount([[build], [qa, code, security], [decision]], [
    ['build', 'qa'], ['build', 'code'], ['build', 'security'], ['qa', 'retry'], ['qa', 'retry'],
    ['code', 'retry'], ['missing', 'retry'], ['retry', 'build'],
  ]);
  assert.deepEqual([...graph.paths()], [
    ['build>qa', 'M180 40 V60 H64 V80'], ['build>code', 'M180 40 V80'], ['build>security', 'M180 40 V60 H296 V80'],
    ['qa>retry', 'M64 120 V140 H180 V160'], ['code>retry', 'M180 120 V160'],
  ]);
  assert.equal(graph.svg.viewBox, '0 0 360 500');
  graph.dispose();
});

test('nonadjacent edges bypass intervening cards and an opened sibling panel adds an independent bypass track', () => {
  const build = card('build', 130, 0, 100), qa = card('qa', 14, 80, 100), code = card('review', 246, 80, 100);
  const decision = card('retry', 130, 260, 100);
  const graph = mount([[build], [qa, code], [decision]], [['build', 'retry'], ['qa', 'retry'], ['review', 'retry']]);
  const long = graph.paths().get('build>retry');
  assert.match(long, /^M180 40 V[\d.]+ H7 V[\d.]+ H180 V260$/);
  qa.open = true;
  qa.body.getBoundingClientRect = element(14, 128, 332, 100).getBoundingClientRect;
  graph.canvas.fire('toggle');
  graph.observer.notify();
  assert.equal(graph.callbacks.size, 1);
  graph.flush();
  assert.equal(graph.paths().get('qa>retry'), 'M64 228 V244 H180 V260');
  assert.match(graph.paths().get('review>retry'), /^M296 120 V124 H353 V[\d.]+ H180 V260$/);
  assert.equal(graph.callbacks.size, 0);
  graph.window.fire('resize');
  graph.fonts.fire('loadingdone');
  assert.equal(graph.callbacks.size, 1);
  graph.dispose();
  assert.equal(graph.callbacks.size, 0);
  assert.equal(graph.observer.elements.size, 0);
  graph.canvas.fire('toggle');
  graph.window.fire('resize');
  graph.fonts.fire('loadingdone');
  graph.observer.notify();
  assert.equal(graph.callbacks.size, 0);
  assert.equal(graph.paths().size, 0);
});
