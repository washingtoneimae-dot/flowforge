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

const CATEGORY_ORDER = ['triggers', 'logic', 'data', 'code', 'network', 'files', 'flow', 'custom', 'other'];
const catLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

/* ------------------------- script-block helpers ------------------------- */

interface ScriptBlock { blockId: string; startId: string; endId: string; innerIds: string[]; }

function computeBlocks(nodes: Array<{ id: string; data: any }>, edges: Array<{ source: string; target: string }>): ScriptBlock[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>([from]);
    const q = [from];
    while (q.length) {
      for (const t of adj.get(q.pop()!) ?? []) {
        if (!seen.has(t)) { seen.add(t); q.push(t); }
      }
    }
    return seen;
  };
  const starts = nodes.filter((n) => n.data?.type === 'scriptStart');
  const ends = nodes.filter((n) => n.data?.type === 'scriptEnd');
  const blocks: ScriptBlock[] = [];
  for (const s of starts) {
    const bid = String(s.data?.params?.blockId ?? '').trim();
    if (!bid) continue;
    const e = ends.find((x) => String(x.data?.params?.blockId ?? '').trim() === bid);
    if (!e || e.id === s.id) continue;
    const fromStart = reach(s.id);
    const fromEnd = reach(e.id);
    const innerIds = [...fromStart].filter((id) => id !== s.id && !fromEnd.has(id));
    blocks.push({ blockId: bid, startId: s.id, endId: e.id, innerIds });
  }
  return blocks;
}

/* --------------------------------- nodes --------------------------------- */

function PortNode({ data, selected }: NodeProps) {
  const d = data as any;
  const outs: number = d.outputs ?? 1;
  return (
    <div className={`ff-node ${selected ? 'selected' : ''} ${d.status ? 'status-' + d.status : ''} ${d.collapsed ? 'is-collapsed' : ''}`}>
      {d.kind !== 'trigger' && !d.collapsed && <Handle type="target" position={Position.Top} />}
      {d.collapsed && <Handle type="target" position={Position.Top} />}
      <div className="title">{d.collapsed ? `▸ ${d.label}` : d.label}</div>
      <div className="kind">{d.type === 'scriptStart' || d.type === 'scriptEnd' ? `script · ${d.blockId ?? ''}` : d.kind}</div>
      {d.collapsed
        ? (<>
            <div className="kind">{d.collapsedCount} nodes · click to expand in inspector</div>
            <Handle type="source" position={Position.Bottom} id="0" style={{ background: '#111' }} />
          </>)
        : Array.from({ length: outs }).map((_, i) => (
            <Handle
              key={i} type="source" position={Position.Bottom} id={String(i)}
              style={outs > 1 ? { left: `${((i + 1) / (outs + 1)) * 100}%`, background: '#111' } : { background: '#111' }}
            />
          ))}
    </div>
  );
}
const nodeTypes = { port: PortNode };

const loadDisabled = (): string[] => {
  try { return JSON.parse(localStorage.getItem('ff.disabledNodes') ?? '[]'); } catch { return []; }
};

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
  const [testInput, setTestInput] = useState('[{"json": {}}]');
  const [testResult, setTestResult] = useState<any>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [disabled, setDisabled] = useState<string[]>(loadDisabled);

  // library
  const [showLibrary, setShowLibrary] = useState(false);
  const [libSearch, setLibSearch] = useState('');
  const [libCat, setLibCat] = useState('all');
  const [editing, setEditing] = useState<any | null>(null); // custom node draft
  const [editError, setEditError] = useState<string | null>(null);
  const [editTestResult, setEditTestResult] = useState<any>(null);

  useEffect(() => { api('/api/nodes').then(setNodeDefs); api('/api/workflows').then(setWorkflows); }, []);
  const refreshNodes = useCallback(() => api('/api/nodes').then(setNodeDefs), []);

  const toggleDisabled = (key: string) =>
    setDisabled((ds) => {
      const next = ds.includes(key) ? ds.filter((k) => k !== key) : [...ds, key];
      localStorage.setItem('ff.disabledNodes', JSON.stringify(next));
      return next;
    });

  const defOf = useCallback((t: string) => nodeDefs.find((d) => d.key === t), [nodeDefs]);

  useEffect(() => {
    if (!currentId) return;
    api(`/api/workflows/${currentId}`).then((wf) => {
      setName(wf.name);
      setActive(!!wf.active);
      setCollapsed(wf.definition.collapsed ?? []);
      setNodes(wf.definition.nodes.map((n: any) => ({
        id: n.id, type: 'port', position: n.position,
        data: { label: n.label ?? defOf(n.type)?.displayName ?? n.type, type: n.type, params: n.params ?? {}, kind: defOf(n.type)?.kind ?? 'action', outputs: defOf(n.type)?.outputs?.length ?? 1, blockId: n.params?.blockId },
      })));
      setEdges(wf.definition.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.from, target: e.to, sourceHandle: String(e.fromIndex ?? 0) })));
    });
    // eslint-disable-next-line
  }, [currentId, nodeDefs.length]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, sourceHandle: c.sourceHandle ?? '0' }, eds)), [setEdges]);

  const enabledDefs = useMemo(() => nodeDefs.filter((d) => !disabled.includes(d.key)), [nodeDefs, disabled]);

  const paletteGroups = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const d of enabledDefs) {
      const c = d.category ?? 'other';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(d);
    }
    return [...groups.entries()].sort((a, b) => {
      const ia = CATEGORY_ORDER.includes(a[0]) ? CATEGORY_ORDER.indexOf(a[0]) : 99;
      const ib = CATEGORY_ORDER.includes(b[0]) ? CATEGORY_ORDER.indexOf(b[0]) : 99;
      return ia - ib;
    });
  }, [enabledDefs]);

  const addNode = (def: any) => {
    const nid = `n${Date.now().toString(36)}`;
    const params: any = {};
    for (const p of def.properties ?? []) params[p.key] = p.default;
    if (def.key === 'scriptStart' || def.key === 'scriptEnd') params.blockId = `script-${nodes.length + 1}`;
    setNodes((ns) => [...ns, { id: nid, type: 'port', position: { x: 120 + ns.length * 40, y: 80 + ns.length * 60 }, data: { label: def.displayName, type: def.key, params, kind: def.kind, outputs: def.outputs?.length ?? 1, blockId: params.blockId } }]);
  };

  const selected = nodes.find((n) => n.id === selectedId);

  const setParam = (p: any, value: unknown) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== selectedId) return n;
      const params = { ...(n.data as any).params, [p.key]: value };
      return { ...n, data: { ...n.data, params, blockId: n.data.type === 'scriptStart' || n.data.type === 'scriptEnd' ? params.blockId : n.data.blockId } };
    }));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  /* ------------------------------ script blocks ------------------------------ */

  const blocks = useMemo(
    () => computeBlocks(nodes.map((n) => ({ id: n.id, data: n.data })), edges.map((e) => ({ source: e.source, target: e.target }))),
    [nodes, edges],
  );

  const hiddenIds = useMemo(() => {
    const h = new Set<string>();
    for (const b of blocks) {
      if (collapsed.includes(b.blockId)) {
        for (const id of b.innerIds) h.add(id);
        h.add(b.endId);
      }
    }
    return h;
  }, [blocks, collapsed]);

  const visibleNodes = useMemo(
    () => nodes
      .filter((n) => !hiddenIds.has(n.id))
      .map((n) => {
        const b = blocks.find((x) => x.startId === n.id && collapsed.includes(x.blockId));
        return b ? { ...n, data: { ...n.data, collapsed: true, collapsedCount: b.innerIds.length + 1 } } : n;
      }),
    [nodes, hiddenIds, blocks, collapsed],
  );

  const visibleEdges: Edge[] = useMemo(() => {
    const out: Edge[] = edges.filter((e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target));
    // rewire: collapsed end's outgoing edges appear to leave the collapsed start
    for (const b of blocks) {
      if (!collapsed.includes(b.blockId)) continue;
      for (const e of edges) {
        if (e.source === b.endId && !hiddenIds.has(e.target)) {
          out.push({ ...e, id: `synth-${b.blockId}-${e.id}`, source: b.startId, sourceHandle: '0', style: { strokeDasharray: '4 4' } });
        }
      }
    }
    return out;
  }, [edges, hiddenIds, blocks, collapsed]);

  const toggleBlock = (blockId: string) =>
    setCollapsed((c) => (c.includes(blockId) ? c.filter((b) => b !== blockId) : [...c, blockId]));

  const selectedBlock = useMemo(() => {
    if (!selected) return null;
    const t = (selected.data as any).type;
    if (t !== 'scriptStart' && t !== 'scriptEnd') return null;
    const bid = String((selected.data as any).params?.blockId ?? '');
    return { ...(blocks.find((b) => b.blockId === bid) ?? { blockId: bid, startId: '', endId: '', innerIds: [] as string[] }), isCollapsed: collapsed.includes(bid) };
  }, [selected, blocks, collapsed]);

  /* --------------------------------- actions --------------------------------- */

  const save = async () => {
    const definition = {
      nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, position: n.position, params: n.data.params ?? {} })),
      edges: edges.map((e) => ({ from: e.source, to: e.target, fromIndex: Number(e.sourceHandle ?? 0) })),
      collapsed,
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
    setCurrentId(null); setNodes([]); setEdges([]); setName('Untitled workflow'); setRunResult(null); setActive(true); setCollapsed([]);
  };

  const exportWorkflow = async () => {
    if (!currentId) return;
    const doc = await api(`/api/workflows/${currentId}/export`);
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^a-z0-9-_]+/gi, '_')}.flowforge.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importWorkflow = async (file: File) => {
    try {
      const doc = JSON.parse(await file.text());
      const wf = await api('/api/workflows/import', { method: 'POST', body: JSON.stringify(doc.name !== undefined || doc.definition !== undefined ? doc : { name: file.name, definition: doc }) });
      if (wf.error) throw new Error(wf.error);
      api('/api/workflows').then(setWorkflows);
      setCurrentId(wf.id);
    } catch (e) {
      alert(`Import failed: ${(e as Error).message}`);
    }
  };

  const testNode = async () => {
    if (!selected) return;
    let items: any;
    try {
      items = JSON.parse(testInput);
      if (!Array.isArray(items)) throw new Error('must be an array');
    } catch (e) { setTestResult({ error: `Bad test input: ${(e as Error).message}` }); return; }
    const r = await api(`/api/nodes/${(selected.data as any).type}/test`, {
      method: 'POST',
      body: JSON.stringify({ params: (selected.data as any).params ?? {}, items }),
    });
    setTestResult(r);
  };

  /* ------------------------------ library ------------------------------ */

  const libCategories = useMemo(() => {
    const set = new Set(nodeDefs.map((d) => d.category ?? 'other'));
    set.add('custom');
    return ['all', ...[...set].sort((a, b) => {
      const ia = CATEGORY_ORDER.includes(a) ? CATEGORY_ORDER.indexOf(a) : 99;
      const ib = CATEGORY_ORDER.includes(b) ? CATEGORY_ORDER.indexOf(b) : 99;
      return ia - ib;
    })];
  }, [nodeDefs]);

  const libNodes = useMemo(() => nodeDefs.filter((d) => {
    if (libCat !== 'all' && (d.category ?? 'other') !== libCat) return false;
    if (!libSearch.trim()) return true;
    const q = libSearch.toLowerCase();
    return d.displayName.toLowerCase().includes(q) || d.key.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q);
  }), [nodeDefs, libSearch, libCat]);

  const openNewCustom = () => {
    setEditing({ key: '', displayName: '', description: '', category: 'custom', properties: '[]', code: '// items: [{ json }], params: your fields\nreturn items.map(i => ({ json: { ...i.json } }));' });
    setEditError(null);
    setEditTestResult(null);
  };

  const openEditCustom = async (key: string) => {
    const rows: any[] = await api('/api/custom-nodes');
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    setEditing({ ...row, properties: JSON.stringify(row.properties ?? [], null, 2) });
    setEditError(null);
    setEditTestResult(null);
  };

  const saveCustom = async () => {
    setEditError(null);
    let properties: any = [];
    try {
      properties = editing.properties.trim() ? JSON.parse(editing.properties) : [];
      if (!Array.isArray(properties)) throw new Error('properties must be an array');
    } catch (e) { setEditError(`Bad properties JSON: ${(e as Error).message}`); return; }
    const r = await api('/api/custom-nodes', {
      method: 'POST',
      body: JSON.stringify({ key: editing.key, displayName: editing.displayName, description: editing.description, category: editing.category || 'custom', properties, code: editing.code }),
    });
    if (r.error) { setEditError(r.error); return; }
    await refreshNodes();
    setEditing(null);
  };

  const deleteCustom = async (key: string) => {
    if (!confirm(`Delete custom node "${key}"? Workflows using it will fail until fixed.`)) return;
    await api(`/api/custom-nodes/${key}`, { method: 'DELETE' });
    await refreshNodes();
  };

  const testCustomDraft = async () => {
    setEditTestResult(null);
    let items: any;
    try {
      const raw = (document.getElementById('custom-test-input') as HTMLTextAreaElement)?.value ?? '[{"json":{}}]';
      items = JSON.parse(raw);
      if (!Array.isArray(items)) throw new Error('must be an array');
    } catch (e) { setEditTestResult({ error: `Bad test input: ${(e as Error).message}` }); return; }
    const params: any = {};
    try {
      const props = editing.properties.trim() ? JSON.parse(editing.properties) : [];
      for (const p of props) if (p.default !== undefined) params[p.key] = p.default;
    } catch { /* ignore */ }
    const r = await api('/api/custom-nodes/test', { method: 'POST', body: JSON.stringify({ code: editing.code, params, items }) });
    setEditTestResult(r);
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>Flowforge</h1>
        <input name="wfname" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active
        </label>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setShowLibrary(true)}>Library</button>
        <button className="btn ghost" onClick={newWorkflow}>New</button>
        <button className="btn ghost" onClick={exportWorkflow} disabled={!currentId} title={currentId ? 'Download workflow JSON' : 'Save first'}>Export</button>
        <label className="btn ghost" style={{ cursor: 'pointer' }}>Import
          <input type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importWorkflow(f); e.target.value = ''; }} />
        </label>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn primary" onClick={run}>Run</button>
      </div>
      <div className="body">
        <aside className="sidebar">
          {paletteGroups.map(([cat, defs]) => (
            <div key={cat}>
              <h2>{catLabel(cat)}</h2>
              {defs.map((d) => <button key={d.key} className="node-btn" onClick={() => addNode(d)}>{d.displayName}<small>+</small></button>)}
            </div>
          ))}
          <h2>Workflows</h2>
          {workflows.map((w) => (
            <div key={w.id} className={`wf-item ${w.id === currentId ? 'active' : ''}`} onClick={() => setCurrentId(w.id)}>{w.name}</div>
          ))}
        </aside>
        <div className="canvas">
          <ReactFlow
            nodes={visibleNodes} edges={visibleEdges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedId(n.id); setTestResult(null); }} onPaneClick={() => setSelectedId(null)} fitView
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
              {selectedBlock && (
                <>
                  <h3 style={{ marginTop: 20 }}>Script block</h3>
                  <div className="desc">
                    {selectedBlock.startId && selectedBlock.endId
                      ? `${selectedBlock.innerIds.length} nodes inside · ${selectedBlock.isCollapsed ? 'collapsed' : 'expanded'}`
                      : `No matching ${selected.data.type === 'scriptStart' ? 'Script End' : 'Script Start'} with this Block ID yet — add one and set the same Block ID.`}
                  </div>
                  {selectedBlock.startId && selectedBlock.endId && (
                    <button className="btn" onClick={() => toggleBlock(selectedBlock.blockId)}>
                      {selectedBlock.isCollapsed ? 'Expand script' : 'Collapse to one node'}
                    </button>
                  )}
                </>
              )}
              <div style={{ marginTop: 12 }}>
                <button className="btn ghost" onClick={deleteSelected}>Delete node</button>
              </div>
              <h3 style={{ marginTop: 20 }}>Test this node</h3>
              <label className="field">
                <span>Test input (items array)</span>
                <textarea rows={3} value={testInput} onChange={(e) => setTestInput(e.target.value)} />
              </label>
              <button className="btn" onClick={testNode}>Run test</button>
              {testResult && (
                <pre className="run" style={{ marginTop: 8 }}>{JSON.stringify(testResult, null, 2)}</pre>
              )}
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

      {showLibrary && (
        <div className="overlay" onClick={() => { setShowLibrary(false); setEditing(null); }}>
          <div className="library" onClick={(e) => e.stopPropagation()}>
            <div className="lib-head">
              <h2>Node Library</h2>
              <div className="spacer" />
              {!editing && <button className="btn primary" onClick={openNewCustom}>+ New node</button>}
              <button className="btn ghost" onClick={() => { setShowLibrary(false); setEditing(null); }}>Close</button>
            </div>
            {editing ? (
              <div className="editor">
                <div className="editor-form">
                  <label className="field"><span>Key (letters, digits, _ — used in workflows)</span>
                    <input value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} placeholder="myNode" /></label>
                  <label className="field"><span>Display name</span>
                    <input value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} placeholder="My Node" /></label>
                  <label className="field"><span>Description</span>
                    <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="What it does" /></label>
                  <label className="field"><span>Category</span>
                    <input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="custom" /></label>
                  <label className="field"><span>Properties (JSON array of fields shown in the inspector)</span>
                    <textarea rows={4} value={editing.properties} onChange={(e) => setEditing({ ...editing, properties: e.target.value })}
                      placeholder='[{"key":"field","displayName":"Field","type":"string","default":""}]' /></label>
                  {editError && <div className="error">{editError}</div>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn primary" onClick={saveCustom}>Save node</button>
                    <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
                <div className="editor-code">
                  <label className="field"><span>Code — <code>items</code> and <code>params</code> are in scope. Return items or <code>{'{ branches }'}</code>.</span>
                    <textarea className="codebox" rows={18} value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} spellCheck={false} /></label>
                  <label className="field"><span>Test input</span>
                    <textarea id="custom-test-input" rows={3} defaultValue='[{"json":{}}]' /></label>
                  <button className="btn" onClick={testCustomDraft}>Run test</button>
                  {editTestResult && <pre className="run" style={{ marginTop: 8 }}>{JSON.stringify(editTestResult, null, 2)}</pre>}
                </div>
              </div>
            ) : (
              <>
                <div className="lib-filters">
                  <input placeholder="Search nodes…" value={libSearch} onChange={(e) => setLibSearch(e.target.value)} />
                  <select value={libCat} onChange={(e) => setLibCat(e.target.value)}>
                    {libCategories.map((c) => <option key={c} value={c}>{c === 'all' ? 'All categories' : catLabel(c)}</option>)}
                  </select>
                </div>
                <div className="lib-grid">
                  {libNodes.map((d) => (
                    <div key={d.key} className={`lib-card ${disabled.includes(d.key) ? 'is-disabled' : ''}`}>
                      <div className="lib-card-title">{d.displayName}</div>
                      <div className="lib-badges">
                        <span className="badge">{d.kind}</span>
                        <span className="badge">{d.category ?? 'other'}</span>
                        {d.custom && <span className="badge dark">custom</span>}
                        {disabled.includes(d.key) && <span className="badge dark">disabled</span>}
                      </div>
                      <div className="lib-card-desc">{d.description || <span className="muted">No description.</span>}</div>
                      <div className="lib-card-key muted">{d.key} · v{d.version}</div>
                      <div className="lib-card-actions">
                        <button className="btn ghost" disabled={disabled.includes(d.key)} onClick={() => { addNode(d); setShowLibrary(false); }}>Add</button>
                        <button className="btn ghost" onClick={() => toggleDisabled(d.key)}>{disabled.includes(d.key) ? 'Enable' : 'Disable'}</button>
                        {d.custom && <>
                          <button className="btn ghost" onClick={() => openEditCustom(d.key)}>Edit</button>
                          <button className="btn ghost" onClick={() => deleteCustom(d.key)}>Delete</button>
                        </>}
                      </div>
                    </div>
                  ))}
                </div>
                {libNodes.length === 0 && <p className="muted">No nodes match.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
