'use strict';
// Small input validator (no extra package). Every route validates its body and
// query with a schema. Unknown fields are rejected, as agreed in docs/api.md.
const { badRequest } = require('./errors');
const dates = require('./dates');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function checkField(name, value, rule) {
  if (value === undefined || value === null || value === '') {
    return rule.required ? `${name} is required` : null;
  }
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be text`;
      if (rule.min && value.trim().length < rule.min) return `${name} must be at least ${rule.min} characters`;
      if (rule.max && value.length > rule.max) return `${name} must be at most ${rule.max} characters`;
      if (rule.pattern && !rule.pattern.test(value)) return `${name} has an invalid format`;
      return null;
    case 'email': return typeof value === 'string' && EMAIL_RE.test(value) && value.length <= 254 ? null : `${name} must be a valid email`;
    case 'uuid': return typeof value === 'string' && UUID_RE.test(value) ? null : `${name} must be a valid id`;
    case 'date': return dates.isValidDate(value) ? null : `${name} must be a date in YYYY-MM-DD format`;
    case 'month': return dates.isValidMonth(value) ? null : `${name} must be a month in YYYY-MM format`;
    case 'week': return dates.isValidWeek(value) ? null : `${name} must be a week in YYYY-Www format`;
    case 'time': return dates.isValidTime(value) ? null : `${name} must be a time in HH:MM format`;
    case 'datetime': return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `${name} must be a date and time`;
    case 'boolean': return typeof value === 'boolean' ? null : `${name} must be true or false`;
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n)) return `${name} must be a whole number`;
      if (rule.min !== undefined && n < rule.min) return `${name} must be at least ${rule.min}`;
      if (rule.max !== undefined && n > rule.max) return `${name} must be at most ${rule.max}`;
      return null;
    }
    case 'enum': return rule.values.includes(value) ? null : `${name} must be one of: ${rule.values.join(', ')}`;
    case 'array': {
      if (!Array.isArray(value)) return `${name} must be a list`;
      if (rule.max && value.length > rule.max) return `${name} can have at most ${rule.max} items`;
      for (const item of value) {
        const err = checkField(`${name} item`, item, rule.items);
        if (err) return err;
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return `${name} must be an object`;
      const errs = collect(value, rule.fields, name);
      return errs.length ? errs[0].issue : null;
    }
    default: return `${name} has an unknown rule`;
  }
}

function collect(input, schema, prefix) {
  const details = [];
  const obj = input && typeof input === 'object' ? input : {};
  for (const key of Object.keys(obj)) {
    if (!schema[key]) details.push({ field: prefix ? `${prefix}.${key}` : key, issue: 'is not an allowed field' });
  }
  for (const [key, rule] of Object.entries(schema)) {
    const issue = checkField(key, obj[key], rule);
    if (issue) details.push({ field: prefix ? `${prefix}.${key}` : key, issue });
  }
  return details;
}

// Throws 400 VALIDATION_FAILED with details when the input is invalid.
function validate(input, schema) {
  const details = collect(input, schema);
  if (details.length) throw badRequest('VALIDATION_FAILED', 'Some fields are invalid.', details);
  return input || {};
}

const middleware = {
  body: (schema) => (req, _res, next) => { try { validate(req.body, schema); next(); } catch (e) { next(e); } },
  query: (schema) => (req, _res, next) => { try { validate(req.query, schema); next(); } catch (e) { next(e); } },
  params: (schema) => (req, _res, next) => { try { validate(req.params, schema); next(); } catch (e) { next(e); } },
};

module.exports = { validate, ...middleware, UUID_RE };
