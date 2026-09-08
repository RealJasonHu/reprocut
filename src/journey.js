import { open } from 'node:fs/promises';

const actionFields = {
  click: ['selector'], fill: ['selector', 'value'], press: ['selector', 'key'],
  select: ['selector', 'value'], check: ['selector'], uncheck: ['selector'],
  'wait-for': ['selector', 'state'],
};
const failureFields = {
  'page-error': ['includes'], 'console-error': ['includes'],
  'http-error': ['urlIncludes', 'status'], visible: ['selector', 'textIncludes'],
};
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
}
function keys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key} is unknown`);
}
function string(value, path, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > 10000) {
    throw new Error(`${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string (max 10000 characters)`);
  }
}
function integer(value, min, max, path) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${path} must be an integer from ${min} to ${max}`);
}

/** Strict data-only journey input. Unknown keys are errors, never silently ignored. */
export function validateJourney(value) {
  object(value, 'journey');
  keys(value, ['version', 'name', 'url', 'setup', 'actions', 'failure', 'options'], 'journey');
  if (value.version !== 1) throw new Error('journey.version must be 1');
  string(value.name, 'journey.name');
  string(value.url, 'journey.url');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('journey.url must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('journey.url must use HTTP(S) without embedded credentials');
  }
  const ids = new Set();
  function actions(list, path) {
    if (!Array.isArray(list) || list.length > 200) throw new Error(`${path} must be an array with at most 200 actions`);
    return list.map((action, index) => {
      const at = `${path}[${index}]`;
      object(action, at);
      if (!Object.hasOwn(actionFields, action.type)) throw new Error(`${at}.type is unsupported`);
      keys(action, ['id', 'type', 'label', ...actionFields[action.type]], at);
      string(action.id, `${at}.id`);
      if (ids.has(action.id)) throw new Error(`Duplicate action id: ${action.id}`);
      ids.add(action.id);
      if (action.label !== undefined) string(action.label, `${at}.label`);
      for (const field of actionFields[action.type]) string(action[field], `${at}.${field}`, field === 'value');
      if (action.type === 'wait-for' && !['visible', 'hidden', 'attached', 'detached'].includes(action.state)) throw new Error(`${at}.state is unsupported`);
      return { ...action };
    });
  }
  const setup = actions(value.setup ?? [], 'journey.setup');
  const steps = actions(value.actions, 'journey.actions');
  const failure = value.failure;
  object(failure, 'journey.failure');
  if (!Object.hasOwn(failureFields, failure.type)) throw new Error('journey.failure.type is unsupported');
  keys(failure, ['type', ...failureFields[failure.type]], 'journey.failure');
  for (const field of failureFields[failure.type]) {
    if (field === 'status') integer(failure.status, 400, 599, 'journey.failure.status');
    else string(failure[field], `journey.failure.${field}`);
  }
  const options = value.options ?? {};
  object(options, 'journey.options');
  keys(options, ['actionTimeoutMs', 'observeMs', 'viewport'], 'journey.options');
  const actionTimeoutMs = options.actionTimeoutMs ?? 1000;
  const observeMs = options.observeMs ?? 150;
  integer(actionTimeoutMs, 100, 60000, 'journey.options.actionTimeoutMs');
  integer(observeMs, 0, 10000, 'journey.options.observeMs');
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  object(viewport, 'journey.options.viewport');
  keys(viewport, ['width', 'height'], 'journey.options.viewport');
  integer(viewport.width, 320, 3840, 'journey.options.viewport.width');
  integer(viewport.height, 240, 2160, 'journey.options.viewport.height');
  return { version: 1, name: value.name, url: url.href, setup, actions: steps, failure: { ...failure }, options: { actionTimeoutMs, observeMs, viewport: { ...viewport } } };
}

export async function loadJourney(path) {
  const limit = 2 * 1024 * 1024;
  const file = await open(path, 'r');
  const buffer = Buffer.alloc(limit + 1);
  let size = 0;
  try {
    if (!(await file.stat()).isFile()) throw new Error('Journey input must be a regular file');
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
  } finally { await file.close(); }
  if (size > limit) throw new Error('Journey is larger than the 2 MiB input limit');
  const source = buffer.subarray(0, size).toString('utf8');
  let value;
  try { value = JSON.parse(source); } catch (error) { throw new Error(`Invalid journey JSON: ${error.message}`); }
  return validateJourney(value);
}
