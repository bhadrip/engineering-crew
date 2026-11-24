export function codexToml(value) {
  if (Array.isArray(value)) return '[' + value.map(codexToml).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .map(([key, item]) => codexToml(key) + '=' + codexToml(item)).join(',') + '}';
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f');
}
