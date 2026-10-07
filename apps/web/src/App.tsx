import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  Handle, Position, NodeProps, Edge, Connection,
} from '@xyflow/react';
import './index.css';

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  return r.json();
};

function PortNode({ data, selected }: NodeProps) {
  const d = data as any;
  const outs: number = d.outputs ?? 1;
  return (
    <div className={`ff-node ${selected ? 'selected' : ''} ${d.status ? 'status-' + d.status : ''}`}>
      {d.kind !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="title">{d.label}</div>
      <div className="kind">{d.kind}</div>
      {Array.from({ length: outs }).map((_, i) => (
        <Handle
          key={i} type="source" position={Position.Bottom} id={String(i)}
          style={outs > 1 ? { left: `${((i + 1) / (outs + 1)) * 100}%`, background: '#111' } : { background: '#111' }}
        />
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
  const [active, setActive] = useState(true);

  useEffect(() => { api('/api/nodes').then(setNodeDefs); api('/api/workflows').then(setWorkflows); }, []);

  const defOf = useCallback((t: string) => nodeDefs.find((d) => d.key === t), [nodeDefs]);

  useEffect(() => {
    if (!currentId) return;
    api(`/api/workflows/${currentId}`).then((wf) => {
      setName(wf.name);
      setActive(!!wf.active);
      setNodes(wf.definition.nodes.map((n: any) => ({
        id: n.id, type: 'port', position: n.position,
        data: { label: n.label ?? defOf(n.type)?.displayName ?? n.type, type: n.type, params: n.params ?? {}, kind: defOf(n.type)?.kind ?? 'action', outputs: defOf(n.type)?.outputs?.length ?? 1 },
      })));
      setEdges(wf.definition.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.from, target: e.to, sourceHandle: String(e.fromIndex ?? 0) })));
    });
    // eslint-disable-next-line
  }, [currentId, nodeDefs.length]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, sourceHandle: c.sourceHandle ?? '0' }, eds)), [setEdges]);

  const addNode = (def: any) => {
    const nid = `n${Date.now().toString(36)}`;
    const params: any = {};
    for (const p of def.properties ?? []) params[p.key] = p.default;
    setNodes((ns) => [...ns, { id: nid, type: 'port', position: { x: 120 + ns.length * 40, y: 80 + ns.length * 60 }, data: { label: def.displayName, type: def.key, params, kind: def.kind, outputs: def.outputs?.length ?? 1 } }]);
  };

  const selected = nodes.find((n) => n.id === selectedId);

  const setParam = (p: any, value: unknown) =>
    setNodes((ns) => ns.map((n) => n.id === selectedId ? { ...n, data: { ...n.data, params: { ...(n.data as any).params, [p.key]: value } } } : n));

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const save = async () => {
    const definition = {
      nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, position: n.position, params: n.data.params ?? {} })),
      edges: edges.map((e) => ({ from: e.source, to: e.target, fromIndex: Number(e.sourceHandle ?? 0) })),
    };
    if (currentId) await api(`/api/workflows/${currentId}`, { method: 'PUT', body: JSON.stringify({ name, definition, active: active ? 1 : 0 }) });
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
    const statusByNode: Record<string, string> = {};
    for (const nr of r.results ?? []) statusByNode[nr.nodeId] = nr.status;
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: statusByNode[n.id] } })));
  };

  const newWorkflow = async () => {
    setCurrentId(null); setNodes([]); setEdges([]); setName('Untitled workflow'); setRunResult(null); setActive(true);
  };

  const triggers = useMemo(() => nodeDefs.filter((d) => d.kind === 'trigger'), [nodeDefs]);
  const actions = useMemo(() => nodeDefs.filter((d) => d.kind !== 'trigger'), [nodeDefs]);

  return (
    <div className="app">
      <div className="topbar">
        <h1>Flowforge</h1>
        <input name="wfname" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active
        </label>
        <div className="spacer" />
        <button className="btn ghost" onClick={newWorkflow}>New</button>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn primary" onClick={run}>Run</button>
      </div>
      <div className="body">
        <aside className="sidebar">
          <h2>Triggers</h2>
          {triggers.map((d) => <button key={d.key} className="node-btn" onClick={() => addNode(d)}>{d.displayName}<small>+</small></button>)}
          <h2>Actions</h2>
          {actions.map((d) => <button key={d.key} className="node-btn" onClick={() => addNode(d)}>{d.displayName}<small>+</small></button>)}
          <h2>Workflows</h2>
          {workflows.map((w) => (
            <div key={w.id} className={`wf-item ${w.id === currentId ? 'active' : ''}`} onClick={() => setCurrentId(w.id)}>{w.name}</div>
          ))}
        </aside>
        <div className="canvas">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} onPaneClick={() => setSelectedId(null)} fitView
          >
            <Background color="#ddd" gap={16} /><Controls /><MiniMap />
          </ReactFlow>
        </div>
        <aside className="inspector">
          {selected ? (
            <>
              <h3>{String((selected.data as any).label)}</h3>
              <div className="desc">{defOf((selected.data as any).type)?.description}</div>
              {(defOf((selected.data as any).type)?.properties ?? []).map((p: any) => (
                <label key={p.key} className="field">
                  <span>{p.displayName}</span>
                  {p.type === 'options' ? (
                    <select value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, e.target.value)}>
                      {p.options.map((o: any) => <option key={String(o.value)} value={o.value}>{o.name}</option>)}
                    </select>
                  ) : p.type === 'code' || p.type === 'json' ? (
                    <textarea rows={p.type === 'code' ? 8 : 4} value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, e.target.value)} />
                  ) : p.type === 'number' ? (
                    <input type="number" value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, Number(e.target.value))} />
                  ) : (
                    <input value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, e.target.value)} />
                  )}
                </label>
              ))}
              <button className="btn ghost" onClick={deleteSelected}>Delete node</button>
            </>
          ) : <p className="muted">Select a node to configure it.</p>}
          {runResult && (
            <>
              <h3 style={{ marginTop: 20 }}>Last run — {runResult.status}</h3>
              <pre className="run">{JSON.stringify(runResult.results?.map((r: any) => ({ node: r.nodeId, status: r.status, error: r.error, items: r.items?.length })), null, 2)}</pre>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
