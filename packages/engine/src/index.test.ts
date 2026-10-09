import { describe, it, expect } from 'vitest';
import { executeWorkflow, Workflow } from './index.js';
import type { NodeDefinition } from '@flowforge/node-sdk';

const passthrough: NodeDefinition = {
  key: 'passthrough', displayName: 'Passthrough', description: '', version: 1,
  kind: 'action', inputs: ['main'], outputs: ['main'], properties: [],
  execute: (ctx) => ctx.items,
};
const addField: NodeDefinition = {
  key: 'addField', displayName: 'Add Field', description: '', version: 1,
  kind: 'action', inputs: ['main'], outputs: ['main'], properties: [],
  execute: (ctx) => ctx.items.map((i) => ({ json: { ...i.json, seen: true } })),
};
const brancher: NodeDefinition = {
  key: 'brancher', displayName: 'Brancher', description: '', version: 1,
  kind: 'action', inputs: ['main'], outputs: ['main', 'main'], properties: [],
  execute: (ctx) => ({ branches: [[ctx.items[0]], ctx.items.slice(1)] }),
};
const failing: NodeDefinition = {
  key: 'failing', displayName: 'Failing', description: '', version: 1,
  kind: 'action', inputs: ['main'], outputs: ['main'], properties: [],
  execute: () => { throw new Error('boom'); },
};
const slow: NodeDefinition = {
  key: 'slow', displayName: 'Slow', description: '', version: 1,
  kind: 'action', inputs: ['main'], outputs: ['main'], properties: [],
  execute: () => new Promise((r) => setTimeout(() => r([{ json: {} }]), 500)),
};

const resolve = (type: string) => ({ passthrough, addField, brancher, failing, slow } as any)[type];

describe('executeWorkflow', () => {
  it('runs a linear pipeline and threads items', async () => {
    const wf: Workflow = {
      id: 'w1', name: 't',
      nodes: [
        { id: 'a', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
        { id: 'b', type: 'addField', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const res = await executeWorkflow(wf, resolve, { initialItems: [{ json: { x: 1 } }] });
    expect(res.status).toBe('success');
    const b = res.results.find((r) => r.nodeId === 'b')!;
    expect(b.items).toEqual([{ json: { x: 1, seen: true } }]);
  });

  it('routes branch outputs to separate downstream nodes', async () => {
    const wf: Workflow = {
      id: 'w2', name: 't',
      nodes: [
        { id: 'a', type: 'brancher', position: { x: 0, y: 0 }, params: {} },
        { id: 'b', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
        { id: 'c', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ from: 'a', to: 'b', fromIndex: 0 }, { from: 'a', to: 'c', fromIndex: 1 }],
    };
    const res = await executeWorkflow(wf, resolve, { initialItems: [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }] });
    expect(res.results.find((r) => r.nodeId === 'b')!.items).toHaveLength(1);
    expect(res.results.find((r) => r.nodeId === 'c')!.items).toHaveLength(2);
  });

  it('marks downstream nodes skipped when a node fails', async () => {
    const wf: Workflow = {
      id: 'w3', name: 't',
      nodes: [
        { id: 'a', type: 'failing', position: { x: 0, y: 0 }, params: {} },
        { id: 'b', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const res = await executeWorkflow(wf, resolve, { initialItems: [] });
    expect(res.status).toBe('error');
    expect(res.results.find((r) => r.nodeId === 'b')!.status).toBe('skipped');
  });

  it('enforces node timeouts', async () => {
    const wf: Workflow = {
      id: 'w4', name: 't',
      nodes: [{ id: 'a', type: 'slow', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    };
    const res = await executeWorkflow(wf, resolve, { nodeTimeoutMs: 50 });
    expect(res.results[0].status).toBe('error');
    expect(res.results[0].error).toMatch(/timed out/);
  });

  it('merges multiple inputs before running a node', async () => {
    const wf: Workflow = {
      id: 'w5', name: 't',
      nodes: [
        { id: 'a', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
        { id: 'b', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
        { id: 'm', type: 'passthrough', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [{ from: 'a', to: 'm' }, { from: 'b', to: 'm' }],
    };
    const res = await executeWorkflow(wf, resolve, { initialItems: [{ json: { n: 1 } }] });
    expect(res.results.find((r) => r.nodeId === 'm')!.items).toHaveLength(2);
  });

  it('emits start/finish hooks and honors a pre-assigned execution id', async () => {
    const wf: Workflow = {
      id: 'w6', name: 't',
      nodes: [{ id: 'a', type: 'passthrough', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    };
    const started: string[] = [];
    const finished: string[] = [];
    const res = await executeWorkflow(wf, resolve, {
      initialItems: [{ json: {} }],
      executionId: 'exec_test123',
      onNodeStart: (s) => started.push(s.nodeId),
      onNodeFinish: (r) => finished.push(r.nodeId),
    });
    expect(res.executionId).toBe('exec_test123');
    expect(started).toEqual(['a']);
    expect(finished).toEqual(['a']);
  });

  it('passes executionId and nodeId to node contexts', async () => {
    let seen: any = null;
    const spy: NodeDefinition = {
      key: 'spy', displayName: 'Spy', description: '', version: 1,
      kind: 'action', inputs: ['main'], outputs: ['main'], properties: [],
      execute: (ctx) => { seen = { executionId: (ctx as any).executionId, nodeId: (ctx as any).nodeId }; return ctx.items; },
    };
    const wf: Workflow = {
      id: 'w7', name: 't',
      nodes: [{ id: 'n9', type: 'spy', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    };
    const res = await executeWorkflow(wf, (t) => (t === 'spy' ? spy : undefined), { executionId: 'exec_ctx1' });
    expect(res.status).toBe('success');
    expect(seen).toEqual({ executionId: 'exec_ctx1', nodeId: 'n9' });
  });

  it('honors a node-level timeoutMs over the engine default', async () => {
    const quick: NodeDefinition = {
      key: 'quick', displayName: 'Quick', description: '', version: 1,
      kind: 'action', inputs: ['main'], outputs: ['main'], properties: [],
      timeoutMs: 20,
      execute: () => new Promise((r) => setTimeout(() => r([{ json: {} }]), 500)),
    };
    const wf: Workflow = {
      id: 'w8', name: 't',
      nodes: [{ id: 'a', type: 'quick', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    };
    const res = await executeWorkflow(wf, (t) => (t === 'quick' ? quick : undefined), { nodeTimeoutMs: 5000 });
    expect(res.results[0].status).toBe('error');
    expect(res.results[0].error).toMatch(/timed out/);
  });
});
