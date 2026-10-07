import { describe, it, expect } from 'vitest';
import { evaluateExpression, scopeFor } from './expr.js';

const scope = (json: any, vars: any = {}, params: any = {}) => scopeFor({ json }, vars, params);

describe('evaluateExpression', () => {
  it('passes through values without expressions', () => {
    expect(evaluateExpression('plain', scope({}))).toBe('plain');
    expect(evaluateExpression(42, scope({}))).toBe(42);
    expect(evaluateExpression(undefined, scope({}))).toBe(undefined);
  });
  it('preserves types for whole-value expressions', () => {
    expect(evaluateExpression('{{ $json.n }}', scope({ n: 7 }))).toBe(7);
    expect(evaluateExpression('{{ $json.ok }}', scope({ ok: false }))).toBe(false);
    expect(evaluateExpression('{{ $json.o }}', scope({ o: { a: 1 } }))).toEqual({ a: 1 });
  });
  it('interpolates mixed text', () => {
    expect(evaluateExpression('user-{{ $json.id }}', scope({ id: 9 }))).toBe('user-9');
    expect(evaluateExpression('{{ $json.a }}-{{ $json.b }}', scope({ a: 1, b: 2 }))).toBe('1-2');
    expect(evaluateExpression('v={{ $json.o }}', scope({ o: { x: 1 } }))).toBe('v={"x":1}');
  });
  it('runs real JS with $vars and $params', () => {
    expect(evaluateExpression('{{ $json.n * 2 + $vars.k }}', scope({ n: 3 }, { k: 1 }, {}))).toBe(7);
    expect(evaluateExpression('{{ ($params.prefix ?? "u") + "-" + $json.id }}', scope({ id: 5 }, {}, { prefix: 'U' }))).toBe('U-5');
    expect(evaluateExpression('{{ $json.tags.length }}', scope({ tags: [1, 2, 3] }))).toBe(3);
  });
  it('throws helpful errors', () => {
    expect(() => evaluateExpression('{{ }}', scope({}))).toThrow(/empty/);
    expect(() => evaluateExpression('{{ nope( }}', scope({}))).toThrow(/bad expression/);
    expect(() => evaluateExpression('a {{ missingVar }} b', scope({}))).toThrow(/bad expression/);
  });
});
