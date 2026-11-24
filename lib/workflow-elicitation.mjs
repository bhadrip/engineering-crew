import { requireField } from './contracts.mjs';

const fieldLimit = 32;
const formTextLimit = 16_384;
const scalarTypes = ['string', 'number', 'integer', 'boolean'];
const stringFormats = ['email', 'uri', 'date', 'date-time'];
const compactText = (value, limit) => typeof value === 'string' && value.length <= limit ? value : undefined;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;

function choices(schema, multiple) {
  const item = multiple ? schema.items : schema;
  if (!record(item)) return null;
  const titled = multiple ? item.anyOf : item.oneOf;
  const values = item.enum;
  if (titled == null && values == null) return multiple ? null : undefined;
  const options = Array.isArray(titled) ? titled.map(option => ({ value: option?.const, label: option?.title })) :
    Array.isArray(values) ? values.map((value, index) => ({ value, label: item.enumNames?.[index] ?? value })) : [];
  if (!options.length || options.length > 100 || options.some(({ value, label }) =>
    compactText(value, 500) === undefined || compactText(label, 500) === undefined) ||
    new Set(options.map(option => option.value)).size !== options.length) return null;
  return options;
}

function dateValue(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stringFormat(value, format) {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'uri') return URL.canParse(value);
  if (format === 'date') return /^\d{4}-\d\d-\d\d$/.test(value) && dateValue(value);
  if (format === 'date-time') return /^\d{4}-\d\d-\d\d[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/.test(value) &&
    dateValue(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  return true;
}

function valid(field, value) {
  const { type, options, minimum, maximum, format } = field;
  if (type === 'array') return Array.isArray(value) && new Set(value).size === value.length &&
    value.length >= minimum && value.length <= maximum && value.every(item => options.some(option => option.value === item));
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number' || type === 'integer') return Number.isFinite(value) &&
    (type !== 'integer' || Number.isSafeInteger(value)) && (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum);
  return typeof value === 'string' && (options ? options.some(option => option.value === value) :
    [...value].length >= minimum && [...value].length <= maximum && stringFormat(value, format));
}

function formField(name, schema, required) {
  if (!name || name.length > 200 || !record(schema)) return null;
  const { type } = schema;
  const basic = { name, label: compactText(schema.title, 500) || name, required,
    description: compactText(schema.description, 2_000), type };
  if (type === 'boolean') return { ...basic, ...(valid(basic, schema.default) && { default: schema.default }) };
  if (!scalarTypes.includes(type) && type !== 'array') return null;
  if (type === 'string' || type === 'array') {
    const options = choices(schema, type === 'array');
    if (options === null) return null;
    const minimum = (type === 'array' ? schema.minItems : schema.minLength) ?? 0;
    const upperBound = (type === 'array' ? schema.maxItems : schema.maxLength) ?? (options?.length ?? formTextLimit);
    const maximum = Math.min(upperBound, options?.length ?? formTextLimit);
    const format = schema.format;
    if (!whole(minimum) || !whole(upperBound) || maximum < minimum || (format != null && !stringFormats.includes(format))) return null;
    const field = { ...basic, ...(options && { options }), minimum, maximum, ...(format && { format }) };
    return { ...field, ...(valid(field, schema.default) && { default: schema.default }) };
  }
  const minimum = schema.minimum ?? undefined;
  const maximum = schema.maximum ?? undefined;
  if ([minimum, maximum].some(value => value !== undefined && !Number.isFinite(value)) || minimum > maximum) return null;
  const field = { ...basic, minimum, maximum };
  return { ...field, ...(valid(field, schema.default) && { default: schema.default }) };
}

function mcpElicitationForm(params) {
  const schema = params?.requestedSchema;
  if (schema?.type !== 'object' || !record(schema.properties)) return null;
  const required = schema.required ?? [];
  const entries = Object.entries(schema.properties);
  if (entries.length > fieldLimit || !Array.isArray(required) || required.some(key => typeof key !== 'string' ||
    !Object.hasOwn(schema.properties, key))) return null;
  const fields = entries.map(([name, definition]) => formField(name, definition, required.includes(name)));
  return fields.every(Boolean) ? fields : null;
}

export function mcpElicitationDestination(value) {
  if (typeof value !== 'string' || value.length > 8_192 || /[\u0000-\u0020\u007f]/.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) && !url.username && !url.password &&
    url.href.length <= 8_192 ? url : null;
}

export function mcpElicitationRequest(params, server) {
  const message = compactText(params?.message, 4_000);
  if (!server || !message) return null;
  if (params.mode === 'form') {
    const fields = mcpElicitationForm(params);
    return fields && { elicitation: { server, message, fields } };
  }
  if (params.mode !== 'url' || !compactText(params.elicitationId, 2_000)) return null;
  const url = mcpElicitationDestination(params.url);
  if (!url) return null;
  return { elicitation: { mode: 'url', server, destination: url.origin,
    message: message.replaceAll(params.url, url.origin).replaceAll(url.href, url.origin) }, pendingElicitationUrl: url.href };
}

export function mcpElicitationResponse(elicitation, form) {
  const action = form.get('mcp-action');
  requireField(['accept', 'decline', 'cancel'].includes(action), 'Choose how to respond to the MCP tool.');
  if (action !== 'accept' || elicitation.mode === 'url') return { action };
  const content = Object.fromEntries(elicitation.fields.flatMap((field, index) => {
    const raw = form.getAll('mcp-field-' + index);
    const value = raw[0] ?? '';
    if (field.type !== 'array' && !value && !field.required) return [];
    if (field.type === 'array' && !raw.length && !field.required) return [];
    const choice = selected => /^[1-9]\d*$/.test(selected) ? field.options[Number(selected) - 1]?.value : undefined;
    const decoded = field.type === 'array' ? raw.map(choice) : field.options ? choice(value) :
      field.type === 'boolean' ? value === 'true' ? true : value === 'false' ? false : undefined :
      field.type === 'string' ? value : value.trim() ? Number(value) : undefined;
    requireField((field.type === 'array' || raw.length === 1) && valid(field, decoded), 'Enter a valid value for ' + field.label + '.');
    return [[field.name, decoded]];
  }));
  return { action, content };
}
