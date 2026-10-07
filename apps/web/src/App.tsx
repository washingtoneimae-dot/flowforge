import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  Handle, Position, NodeProps, Edge, Connection,
} from '@xyflow/react';

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  return r.json();
};

function PortNode({ data, selected }: NodeProps) {
  const d = data as any;
  return (
    <div style={{ padding: 8, border: selected ? '2px solid #7c5cff' : '1px solid #444', borderRadius: 8, background: '#1e1e2e', color: '#eee', minWidth: 140 }}>
      {d.kind !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div style={{ fontWeight: 700, fontSize: 13 }}>{d.label}</div>
      <div style={{ fontSize: 10, opacity: 0.6 }}>{d.type}</div>
      {d.kind !== 'trigger' ? null : null}
      {(d.type === 'if' ? [0, 1] : d.kind === 'trigger' || d.outputs[0] !== 'none' ? [0] : []).map((i: number) => (
        <Handle key={i} type="source" position={Position.Bottom} id={String(i)} style={d.type === 'if' && i === 1 ? { left: '80%' } : undefined} />
      ))}
    </div>
  );
}
const nodeTypes = { port: PortNode };

export default function App() {
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [name, setName] = useState('Untitled workflow');
  const [nodeDefs, setNodeDefs] = useState<any[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any>(null);

  useEffect(() => { api('/api/nodes').then(setNodeDefs); api('/api/workflows').then(setWorkflows); }, []);

  useEffect(() => {
    if (!currentId) return;
    api(`/api/workflows/${currentId}`).then((wf) => {
      setName(wf.name);
      const defs = nodeDefs.length ? nodeDefs : [];
      setNodes(wf.definition.nodes.map((n: any) => ({
        id: n.id, type: 'port', position: n.position,
        data: { label: displayOf(n.type), type: n.type, params: n.params, kind: kindOf(n.type), outputs: ['main'] },
      })));
      setEdges(wf.definition.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.from, target: e.to, sourceHandle: String(e.fromIndex ?? 0) })));
    });
    // eslint-disable-next-line
  }, [currentId]);

  const displayOf = (t: string) => nodeDefs.find((d) => d.key === t)?.displayName ?? t;
  const kindOf = (t: string) => nodeDefs.find((d) => d.key === t)?.kind ?? 'action';

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, sourceHandle: c.sourceHandle ?? '0' }, eds)), [setEdges]);

  const addNode = (def: any) => {
    const nid = `n${Date.now().toString(36)}`;
    const params: any = {};
    for (const p of def.properties ?? []) params[p.key] = p.default;
    setNodes((ns) => [...ns, { id: nid, type: 'port', position: { x: 80 + ns.length * 60, y: 80 + ns.length * 40 }, data: { label: def.displayName, type: def.key, params, kind: def.kind, outputs: def.outputs } }]);
  };

  const selected = nodes.find((n) => n.id === selectedId);

  const save = async () => {
    const definition = {
      nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, position: n.position, params: n.data.params ?? {} })),
      edges: edges.map((e) => ({ from: e.source, to: e.target, fromIndex: Number(e.sourceHandle ?? 0) })),
    };
    if (currentId) await api(`/api/workflows/${currentId}`, { method: 'PUT', body: JSON.stringify({ name, definition }) });
    else {
      const wf = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ name, definition }) });
      setCurrentId(wf.id);
    }
    api('/api/workflows').then(setWorkflows);
  };

  const run = async () => {
    await save();
    const id = currentId ?? (await api('/api/workflows')).find((w: any) => w.name === name)?.id;
    if (!id) return;
    const r = await api(`/api/workflows/${id}/run`, { method: 'POST', body: '{}' });
    setRunResult(r);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#11111b', color: '#eee', fontFamily: 'system-ui' }}>
      <aside style={{ width: 220, borderRight: '1px solid #333', padding: 12, overflow: 'auto' }}>
        <h3>Flowforge</h3>
        <button onClick={() => { setCurrentId(null); setNodes([]); setEdges([]); setName('Untitled workflow'); }}>+ New</button>
        <h4>Nodes</h4>
        {nodeDefs.map((d) => <button key={d.key} onClick={() => addNode(d)} style={{ display: 'block', margin: '4px 0' }}>+ {d.displayName}</button>)}
        <h4>Workflows</h4>
        {workflows.map((w) => <div key={w.id} style={{ cursor: 'pointer', padding: 4, color: w.id === currentId ? '#7c5cff' : '#aaa' }} onClick={() => setCurrentId(w.id)}>{w.name}</div>)}
      </aside>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 8, display: 'flex', gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button onClick={save}>Save</button>
          <button onClick={run}>▶ Run</button>
        </div>
        <div style={{ flex: 1 }} onClick={() => setSelectedId(null)}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} fitView
          >
            <Background /><Controls /><MiniMap />
          </ReactFlow>
        </div>
      </main>
      <aside style={{ width: 280, borderLeft: '1px solid #333', padding: 12, overflow: 'auto' }}>
        {selected ? (
          <>
            <h4>{String((selected.data as any).label)}</h4>
            {nodeDefs.find((d) => d.key === (selected.data as any).type)?.properties.map((p: any) => (
              <label key={p.key} style={{ display: 'block', margin: '8px 0', fontSize: 12 }}>
                {p.displayName}
                {p.type === 'code' ? (
                  <textarea rows={8} style={{ width: '100%' }} value={(selected.data as any).params?.[p.key] ?? ''}
                    onChange={(e) => setNodes((ns) => ns.map((n) => n.id === selected.id ? { ...n, data: { ...n.data, params: { ...(n.data as any).params, [p.key]: e.target.value } } } : n))} />
                ) : (
                  <input style={{ width: '100%' }} value={(selected.data as any).params?.[p.key] ?? ''}
                    onChange={(e) => setNodes((ns) => ns.map((n) => n.id === selected.id ? { ...n, data: { ...n.data, params: { ...(n.data as any).params, [p.key]: e.target.value } } } : n))} />
                )}
              </label>
            ))}
          </>
        ) : <p style={{ opacity: 0.5 }}>Select a node to edit its parameters.</p>}
        {runResult && (
          <>
            <h4>Last run: {runResult.status}</h4>
            <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap' }}>{JSON.stringify(runResult.results?.map((r: any) => ({ node: r.nodeId, status: r.status, error: r.error, items: r.items?.length })), null, 2)}</pre>
          </>
        )}
      </aside>
    </div>
  );
}
