import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = await readFile(new URL('../ui/workflow-inspector.js', import.meta.url), 'utf8');

function fixture(wide = true) {
  function element() {
    const events = new Map();
    return {
      dataset:{}, attributes:{}, isConnected:true, scrollTop:0,
      addEventListener(name, fn) { events.set(name,fn); },
      fire(name, event = {}) { events.get(name)?.(event); },
      setAttribute(key,value) { this.attributes[key] = value; },
      removeAttribute(key) {
        delete this.attributes[key];
        if (key.startsWith('data-')) delete this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())];
      },
      append(child) { child.parent = this; },
      contains(child) { return child === this || Boolean(child?.parent && this.contains(child.parent)); },
      closest(selector) { return selector === '.workflow-body' ? this.bodyAncestor ?? null : null; },
      focus() { document.activeElement = this; },
      getBoundingClientRect() { return {top:this.top ?? 100, bottom:(this.top ?? 100) + 60}; },
      scrollIntoView(options) { this.scrolledTo = options.block; },
    };
  }
  const document = Object.assign(element(),{body:element()});
  const dialog = Object.assign(element(), { id:'workflow-inspector',
    show() { this.open = true; this.modal = false; },
    showModal() { this.open = true; this.modal = true; },
    close() { this.open = false; },
  });
  const title = element(), slot = element(), context = element(), dismiss = element(), status = element(), performer = element();
  for (const child of [slot, title, context, dismiss, status, performer]) dialog.append(child);
  dialog.querySelector = selector => ({ '#inspector-title':title, '[data-inspector-body]':slot, '[data-inspector-scroll]':slot,
    '[data-inspector-close]':dismiss, '[data-inspector-context]':context, '[data-inspector-status]':status, '[data-inspector-performer]':performer })[selector];
  function stage(key, name, role) {
    const step = Object.assign(element(),{id:'stage-' + key}), summary = element(), body = element();
    Object.assign(step.dataset, {stepTitle:name, stepRole:role, stepContext:'First build', stepResult:'Failed', tone:'warning'});
    step.append(summary);
    step.append(body);
    step.querySelector = selector => selector === ':scope > summary' ? summary : body.parent === step ? body : null;
    return {step,summary,body};
  }
  let stages = [stage('qa-1','Run QA tests','QA agent'),stage('reviewer-1','Review code','Code reviewer')];
  const workflow = {
    querySelectorAll: () => stages.map(s => s.summary),
    querySelector: id => stages.find(s => '#' + s.step.id === id)?.step,
  };
  const desktop = Object.assign(element(),{matches:wide});
  const location = new URL('http://localhost/request#stage-qa-1');
  let replaced;
  const ctx = { document, window:{ location, innerHeight:700, matchMedia:()=>desktop }, URL, CSS:{escape:s=>s},
    history:{replaceState(_s,_t,value) { location.href = value; }},
    replaceLiveSection(previous,next) { replaced = [previous,next]; previous.parent.append(next); previous.parent = null; },
  };
  runInNewContext(script,ctx);
  const inspector = ctx.connectWorkflowInspector(dialog);
  inspector.configure(workflow);
  return { qa:stages[0], review:stages[1], desktop, inspector, title, slot, context, dialog,
    performer, status, dismiss, document, location, workflow,
    refresh() {
      for (const s of stages) { s.summary.isConnected = false; s.step.isConnected = false; }
      stages = [stage('qa-1','Run QA tests','QA agent'),stage('reviewer-1','Review code','Code reviewer')];
      inspector.configure(workflow);
      return {qa:stages[0], review:stages[1], replaced};
    },
  };
}

test('selecting a different graph node swaps the actual body inside the modeless dock and restores focus on close', () => {
  const { inspector, qa, review, title, context, status, slot, dismiss, dialog, document, location } = fixture();
  inspector.select(qa.step,{opener:qa.summary});
  assert.equal(dialog.modal,false);
  assert.equal(qa.step.open,false);
  assert.equal(qa.body.parent,slot);
  assert.equal(qa.summary.attributes['aria-current'],'step');
  assert.equal(context.textContent,'First build');
  inspector.select(review.step,{opener:review.summary});
  assert.equal(title.textContent,'Review code');
  assert.equal(status.textContent,'Failed');
  assert.equal(qa.body.parent,qa.step);
  assert.equal(qa.summary.attributes['aria-current'],undefined);
  assert.equal(review.body.parent,slot);
  assert.equal(document.activeElement,title);
  dismiss.fire('click');
  assert.equal(inspector.selected,null);
  assert.equal(review.body.parent,review.step);
  assert.equal(dialog.open,false);
  assert.equal(document.activeElement,review.summary);
  assert.equal(location.hash,'#workflow');
});

test('responsive modality and live replacement preserve the selected body, scroll and keyboard return path', () => {
  const { qa, inspector, dialog, desktop, slot, refresh, document } = fixture(false);
  qa.summary.top = -5;
  inspector.select(qa.step,{align:true});
  assert.equal(dialog.modal,true);
  assert.equal(qa.summary.scrolledTo,'center');
  slot.scrollTop = 210;
  desktop.matches = true;
  desktop.fire('change');
  assert.equal(dialog.modal,false);
  assert.equal(slot.scrollTop,210);
  const latest = refresh();
  assert.deepEqual(latest.replaced,[qa.body,latest.qa.body]);
  assert.equal(latest.qa.body.parent,slot);
  assert.equal(inspector.selected,latest.qa.step);
  assert.equal(slot.scrollTop,210);
  document.fire('keydown',{key:'Escape',preventDefault() {}});
  assert.equal(dialog.open,false);
  assert.equal(document.activeElement,latest.qa.summary);
});
