// Just enough OpenAPI to check a request or response body against the
// gateway's own schema: $ref, allOf/anyOf/oneOf, types, required, enums,
// ranges, items and additionalProperties. Returns a list of problems, empty
// when the value fits.
import fs from 'node:fs';

export function loadSchema(file = 'docs/vendor/lunatone-dali2-iot-openapi.json') {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function findOperation(spec, method, path) {
  for (const [template, ops] of Object.entries(spec.paths)) {
    const re = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    if (re.test(path) && ops[method.toLowerCase()]) return { template, op: ops[method.toLowerCase()] };
  }
  return null;
}

export function validate(spec, schema, value, at = '$') {
  const problems = [];
  const resolve = (s) => {
    while (s && s.$ref) s = spec.components.schemas[s.$ref.split('/').pop()];
    return s;
  };
  const check = (sch, v, where) => {
    const s = resolve(sch);
    if (!s || Object.keys(s).length === 0) return;
    if (s.allOf) for (const sub of s.allOf) check(sub, v, where);
    if (s.anyOf || s.oneOf) {
      const options = s.anyOf ?? s.oneOf;
      if (!options.some((o) => validate(spec, o, v, where).length === 0)) problems.push(`${where}: matches none of the alternatives`);
      return;
    }
    if (s.enum && !s.enum.includes(v)) problems.push(`${where}: ${JSON.stringify(v)} is not one of ${s.enum.join(', ')}`);
    const type = s.type;
    if (type) {
      const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      const ok = type === 'integer' ? Number.isInteger(v)
        : type === 'number' ? typeof v === 'number'
          : type === actual;
      if (!ok) { problems.push(`${where}: expected ${type}, got ${actual}`); return; }
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) problems.push(`${where}: below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) problems.push(`${where}: above ${s.maximum}`);
    }
    if (Array.isArray(v) && s.items) v.forEach((item, i) => check(s.items, item, `${where}[${i}]`));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const r of s.required ?? []) if (!(r in v)) problems.push(`${where}: missing required ${r}`);
      for (const [k, item] of Object.entries(v)) {
        if (s.properties?.[k]) check(s.properties[k], item, `${where}.${k}`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, item, `${where}.${k}`);
      }
    }
  };
  check(schema, value, at);
  return problems;
}
