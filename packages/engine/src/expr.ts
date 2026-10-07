import vm from 'node:vm';
import type { FlowItem } from '@flowforge/node-sdk';

export interface ExprScope {
  $json: Record<string, unknown>;
  $vars: Record<string, unknown>;
  $params: Record<string, unknown>;
}

const EXPR_RE = /\{\{([\s\S]*?)\}\}/g;
const WHOLE_RE = /^\{\{([\s\S]*?)\}\}$/;

function run(code: string, scope: ExprScope): unknown {
  if (!code.trim()) throw new Error('empty {{ }} expression');
  try {
    return vm.runInNewContext(code, { ...scope }, { timeout: 1000 });
  } catch (err) {
    throw new Error(`bad expression {{${code}}}: ${(err as Error).message}`);
  }
}

/**
 * Resolve `{{ }}` expressions in a parameter value.
 * - No `{{ }}` → returned untouched.
 * - Whole value is one expression → raw result (type preserved).
 * - Mixed text → interpolated string (objects JSON-encoded).
 */
export function evaluateExpression(template: unknown, scope: ExprScope): unknown {
  if (typeof template !== 'string' || !template.includes('{{')) return template;
  // Whole value is exactly one expression → return the raw result (type preserved).
  const whole = (template.match(/\{\{/g) || []).length === 1 ? template.match(WHOLE_RE) : null;
  if (whole) return run(whole[1], scope);
  return template.replace(EXPR_RE, (_m, code: string) => {
    const v = run(code, scope);
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Build the scope for one item: `$json`, `$vars`, `$params`. */
export function scopeFor(item: FlowItem, vars: Record<string, unknown>, params: Record<string, unknown>): ExprScope {
  return { $json: item.json, $vars: vars, $params: params };
}
