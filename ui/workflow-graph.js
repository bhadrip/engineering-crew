// The HTML disclosures and their dependency links remain the source of truth.
function connectWorkflowGraph(canvas, linksRoot = canvas, { nodeSelector = 'details.workflow-step[data-key]',
  portSelector = ':scope > summary', markerId = 'workflow-arrow' } = {}) {
  const svg = canvas?.querySelector('.workflow-wires');
  const wires = svg?.querySelector(':scope > g');
  if (!wires) return () => {};

  const levels = [...canvas.querySelectorAll('.workflow-level')];
  const nodes = new Map();
  levels.forEach((level, index) => {
    for (const card of level.querySelectorAll(nodeSelector)) {
      nodes.set(card.dataset.key, {
        level: index, card, summary: card.querySelector(portSelector), body: card.querySelector(':scope > .workflow-body'),
      });
    }
  });
  const edges = new Map();
  for (const link of linksRoot.querySelectorAll('.workflow-dependency')) {
    const { from, to } = link.dataset;
    if (nodes.has(from) && nodes.has(to) && nodes.get(from).level < nodes.get(to).level) {
      edges.set(from + ':' + to, { from, to });
    }
  }

  let frame = 0, disposed = false;
  const ns = 'http://www.w3.org/2000/svg';
  function draw() {
    frame = 0;
    const viewport = svg.getBoundingClientRect();
    if (disposed || !viewport.width || !viewport.height) return;
    const ports = new Map();
    const ranks = levels.map(() => ({ top: Infinity, bottom: -Infinity, panels: [] }));
    let leftMargin = viewport.width / 2, rightMargin = viewport.width / 2;
    function bounds(element) {
      const rect = element?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return null;
      const box = { left: rect.left - viewport.left, right: rect.right - viewport.left,
        top: rect.top - viewport.top, bottom: rect.bottom - viewport.top };
      leftMargin = Math.min(leftMargin, box.left);
      rightMargin = Math.min(rightMargin, viewport.width - box.right);
      return box;
    }
    for (const [key, node] of nodes) {
      const box = bounds(node.summary);
      if (!box) continue;
      const panel = node.card.open && bounds(node.body);
      const rank = ranks[node.level];
      if (panel) rank.panels.push(panel);
      rank.top = Math.min(rank.top, box.top);
      rank.bottom = Math.max(rank.bottom, box.bottom, panel ? panel.bottom : box.bottom);
      ports.set(key, { level: node.level, x: (box.left + box.right) / 2, top: box.top,
        bottom: panel ? Math.max(box.bottom, panel.bottom) : box.bottom });
    }

    // A long edge, or one blocked by an expanded sibling, uses an outer
    // track. Tracks can be reused once their vertical spans no longer overlap.
    const tracks = { left: [], right: [] };
    const routes = [];
    for (const edge of edges.values()) {
      const a = ports.get(edge.from), b = ports.get(edge.to);
      if (!a || !b || b.top <= a.bottom) continue;
      const sourceRank = ranks[a.level], targetRank = ranks[b.level];
      const obstructing = sourceRank.panels.filter(panel =>
        panel.top >= a.bottom && a.x > panel.left && a.x < panel.right);
      const direct = b.level === a.level + 1 && !obstructing.length;
      const route = { edge, a, b };
      if (direct) {
        route.bend = (sourceRank.bottom + targetRank.top) / 2;
      } else {
        const next = ranks.slice(a.level + 1).find(rank => Number.isFinite(rank.top));
        const prev = ranks.slice(0, b.level).findLast(rank => Number.isFinite(rank.bottom));
        route.exit = obstructing.length ? (a.bottom + Math.min(...obstructing.map(panel => panel.top))) / 2
          : sourceRank.bottom + (next.top - sourceRank.bottom) / 3;
        route.entry = targetRank.top - (targetRank.top - prev.bottom) / 3;
        const side = a.x + b.x <= viewport.width ? 'left' : 'right';
        const available = side => tracks[side].findIndex(spans =>
          spans.every(span => span.end < route.exit || span.start > route.entry));
        const index = side => {
          const free = available(side);
          return free < 0 ? tracks[side].length : free;
        };
        const other = side === 'left' ? 'right' : 'left';
        route.side = index(side) <= index(other) ? side : other;
        route.track = index(route.side);
        (tracks[route.side][route.track] ??= []).push({ start: route.exit, end: route.entry });
      }
      routes.push(route);
    }

    const lines = routes.map(({ edge, a, b, bend, side, track, exit, entry }) => {
      let d = 'M' + a.x + ' ' + a.bottom;
      if (side) {
        const margin = side === 'left' ? leftMargin : rightMargin;
        const inset = Math.max(1, margin * (track + 1) / (tracks[side].length + 1));
        const x = side === 'left' ? inset : viewport.width - inset;
        d += ' V' + exit + ' H' + x + ' V' + entry + ' H' + b.x;
      } else if (a.x !== b.x) {
        d += ' V' + bend + ' H' + b.x;
      }
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('class', 'workflow-wire');
      path.setAttribute('d', d + ' V' + b.top);
      path.setAttribute('data-from', edge.from);
      path.setAttribute('data-to', edge.to);
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', 'url(#' + markerId + ')');
      return path;
    });
    svg.setAttribute('viewBox', '0 0 ' + viewport.width + ' ' + viewport.height);
    wires.replaceChildren(...lines);
  }

  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(draw);
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(canvas);
  for (const level of levels) observer?.observe(level);
  for (const { summary, body } of nodes.values()) {
    if (summary) observer?.observe(summary);
    if (body) observer?.observe(body);
  }
  canvas.addEventListener('toggle', schedule, true);
  window.addEventListener('resize', schedule);
  document.fonts?.addEventListener('loadingdone', schedule);
  schedule();
  return () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
    canvas.removeEventListener('toggle', schedule, true);
    window.removeEventListener('resize', schedule);
    document.fonts?.removeEventListener('loadingdone', schedule);
    wires.replaceChildren();
  };
}
