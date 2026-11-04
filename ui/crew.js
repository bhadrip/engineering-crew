const url = new URL(window.location.href);
if (document.querySelector('[data-epic-view]') && !url.searchParams.has('view')) {
  const legacyViews = { '#pipeline': 'workflow', '#handoff-details': 'workflow', '#qa-heading': 'checks' };
  const view = legacyViews[url.hash];
  if (view) {
    url.searchParams.set('view', view);
    window.location.replace(url);
  }
}
if (url.hash.startsWith('#check-')) {
  const check = document.getElementById(url.hash.slice(1));
  if (check instanceof HTMLDetailsElement) check.open = true;
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
for (const timestamp of document.querySelectorAll('time[data-local]')) {
  const value = new Date(timestamp.dateTime);
  if (!Number.isNaN(value.valueOf())) timestamp.textContent = date.format(value);
}

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey ||
    event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const search = document.querySelector('[data-search]');
  if (!search) return;
  event.preventDefault();
  search.focus();
});
