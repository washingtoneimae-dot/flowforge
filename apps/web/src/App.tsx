import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  Handle, Position, NodeProps, Edge, Connection, BezierEdge, EdgeProps, EdgeLabelRenderer, useReactFlow,
} from '@xyflow/react';
import './index.css';

const CodeField = React.lazy(() => import('./CodeField.js'));
const CodeFieldFallback = ({ height }: { height: number | string }) => (
  <div className="monaco-wrap muted" style={{ height, padding: 10 }}>Loading editor…</div>
);

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

const BUILTIN_ICONS: Record<string, string> = {
  play: '▶️', webhook: '🪝', clock: '⏰', globe: '🌐', pen: '✏️',
  split: '🔀', fork: '🚦', filter: '🔍', merge: '🔗', code: '💻',
  terminal: '🐍', circle: '⚪', hourglass: '⏳', list: '📋', layers: '🗂️',
  calendar: '📅', key: '🔑', braces: '🧾', mail: '✉️', folder: '📁',
  'chevron-right': '⏩', 'chevron-left': '⏪', puzzle: '🧩',
};

function NodeIcon({ icon, custom }: { icon?: string; custom?: boolean }) {
  if (!icon) return null;
  if (icon.startsWith('data:image/')) return <span className="node-icon"><img src={icon} alt="" /></span>;
  if (custom) return icon.length <= 16 ? <span className="node-icon emoji">{icon}</span> : null;
  const mapped = BUILTIN_ICONS[icon];
  return mapped ? <span className="node-icon emoji">{mapped}</span> : null;
}

function PortNode({ data, selected }: NodeProps) {
  const d = data as any;
  const outs: number = d.outputs ?? 1;
  return (
    <div className={`ff-node ${selected ? 'selected' : ''} ${d.status ? 'status-' + d.status : ''} ${d.collapsed ? 'is-collapsed' : ''}`}>
      {d.kind !== 'trigger' && !d.collapsed && <Handle type="target" position={Position.Top} />}
      {d.collapsed && <Handle type="target" position={Position.Top} />}
      <div className="node-row">
        <NodeIcon icon={d.icon} custom={(d as any).custom} />
        <div>
          <div className="title">{d.collapsed ? `▸ ${d.label}` : d.label}</div>
          <div className="kind">{d.type === 'scriptStart' || d.type === 'scriptEnd' ? `script · ${d.blockId ?? ''}` : d.kind}</div>
        </div>
      </div>
      {d.status === 'error' && <span className="err-dot" title={d.error ?? 'error'}>!</span>}
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

function FileField({ value, onChange, scope, nodeKey }: { value: string; onChange: (v: string) => void; scope: string; nodeKey?: string }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; dir: boolean }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const joinP = (base: string, name: string) => (base ? `${base}/${name}` : name).replace(/\/$/, '');
  const browse = async (p: string) => {
    setErr(null);
    const qs = new URLSearchParams({ scope, path: p });
    if (nodeKey) qs.set('node', nodeKey);
    const r = await api(`/api/files?${qs}`);
    if (r.error) { setErr(r.error); return; }
    setPath(r.path ?? '');
    setEntries(r.entries ?? []);
    setOpen(true);
  };
  return (
    <div>
      <div className="row">
        <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="path or {{ $json.file }}" />
        <button type="button" className="btn ghost" onClick={() => (open ? setOpen(false) : browse(''))}>Browse</button>
      </div>
      {open && (
        <div className="file-list">
          {err && <div className="error">{err}</div>}
          {path !== '' && <div className="file-row" onClick={() => browse(path.split('/').slice(0, -1).join('/'))}>.. (up)</div>}
          {(entries ?? []).map((e) => (
            <div key={e.name} className="file-row" onClick={() => (e.dir ? browse(joinP(path, e.name)) : (onChange(joinP(path, e.name)), setOpen(false)))}>
              {e.dir ? '📁 ' : '📄 '}{e.name}
            </div>
          ))}
          <button type="button" className="btn ghost" onClick={() => { onChange(path); setOpen(false); }}>Use this folder</button>
        </div>
      )}
    </div>
  );
}

function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, selected }: EdgeProps) {
  const { setEdges } = useReactFlow();
  return (
    <>
      <BezierEdge id={id} sourceX={sourceX} sourceY={sourceY} targetX={targetX} targetY={targetY} sourcePosition={sourcePosition} targetPosition={targetPosition} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {(selected) && (
          <button
            className="edge-delete nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px,${(sourceY + targetY) / 2}px)` }}
            onClick={(e) => { e.stopPropagation(); setEdges((es) => es.filter((x) => x.id !== id)); }}
            title="Delete connection"
          >×</button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { deletable: DeletableEdge };

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
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const v = Number(localStorage.getItem('ff.inspectorWidth') ?? 300);
    return Math.min(700, Math.max(240, Number.isFinite(v) ? v : 300));
  });

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorRef.current?.offsetWidth ?? inspectorWidth;
    const clamp = (w: number) => Math.min(700, Math.max(240, w));
    const onMove = (ev: MouseEvent) => setInspectorWidth(clamp(startW + (startX - ev.clientX)));
    const onUp = (ev: MouseEvent) => {
      localStorage.setItem('ff.inspectorWidth', String(clamp(startW + (startX - ev.clientX))));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [disabled, setDisabled] = useState<string[]>(loadDisabled);
  const [collapsedCats, setCollapsedCats] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('ff.collapsedCats') ?? '[]'); } catch { return []; }
  });

  const toggleCat = (cat: string) =>
    setCollapsedCats((cs) => {
      const next = cs.includes(cat) ? cs.filter((c) => c !== cat) : [...cs, cat];
      localStorage.setItem('ff.collapsedCats', JSON.stringify(next));
      return next;
    });

  // library
  const [showLibrary, setShowLibrary] = useState(false);
  const [libSearch, setLibSearch] = useState('');
  const [libCat, setLibCat] = useState('all');
  const [editing, setEditing] = useState<any | null>(null); // custom node draft
  const [editError, setEditError] = useState<string | null>(null);
  const [editTestResult, setEditTestResult] = useState<any>(null);
  const [editSaveResult, setEditSaveResult] = useState<any>(null);
  const [editVersions, setEditVersions] = useState<any[]>([]);
  const [similar, setSimilar] = useState<any[]>([]);
  const [customTestInput, setCustomTestInput] = useState('[{"json":{}}]');

  // settings / MCP setup
  const [showSettings, setShowSettings] = useState(false);
  const [mcp, setMcp] = useState<any>(null);
  const [draftUrl, setDraftUrl] = useState('');
  const [draftDisabled, setDraftDisabled] = useState<string[]>([]);
  const [settingsClient, setSettingsClient] = useState('claude-code');
  const [copied, setCopied] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const [exprKeys, setExprKeys] = useState<string[]>([]);
  const exprOn = (nodeId: string, key: string) => exprKeys.includes(`${nodeId}:${key}`);
  const toggleExpr = (nodeId: string, key: string) =>
    setExprKeys((ks) => (exprOn(nodeId, key) ? ks.filter((k) => k !== `${nodeId}:${key}`) : [...ks, `${nodeId}:${key}`]));

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
        data: { label: n.label ?? defOf(n.type)?.displayName ?? n.type, type: n.type, params: n.params ?? {}, kind: defOf(n.type)?.kind ?? 'action', outputs: defOf(n.type)?.outputs?.length ?? 1, icon: defOf(n.type)?.icon, custom: defOf(n.type)?.custom, blockId: n.params?.blockId },
      })));
      setEdges(wf.definition.edges.map((e: any, i: number) => ({ id: `e${i}`, type: 'deletable', source: e.from, target: e.to, sourceHandle: String(e.fromIndex ?? 0) })));
    });
    // eslint-disable-next-line
  }, [currentId, nodeDefs.length]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, type: 'deletable', sourceHandle: c.sourceHandle ?? '0' }, eds)), [setEdges]);

  const enabledDefs = useMemo(() => nodeDefs.filter((d) => !disabled.includes(d.key) && !d.trust?.disabled), [nodeDefs, disabled]);

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
    setNodes((ns) => [...ns, { id: nid, type: 'port', position: { x: 120 + ns.length * 40, y: 80 + ns.length * 60 }, data: { label: def.displayName, type: def.key, params, kind: def.kind, outputs: def.outputs?.length ?? 1, icon: def.icon, custom: def.custom, blockId: params.blockId } }]);
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
          out.push({ ...e, id: `synth-${b.blockId}-${e.id}`, type: 'deletable', source: b.startId, sourceHandle: '0', style: { strokeDasharray: '4 4' } });
        }
      }
    }
    return out;
  }, [edges, hiddenIds, blocks, collapsed]);

  const toggleBlock = (blockId: string) =>
    setCollapsed((c) => (c.includes(blockId) ? c.filter((b) => b !== blockId) : [...c, blockId]));

  // Static problems: unknown types, unconnected inputs, empty required params.
  const problems = useMemo(() => {
    const list: Array<{ nodeId: string; label: string; message: string }> = [];
    for (const n of nodes) {
      const type = (n.data as any).type;
      const label = String((n.data as any).label ?? type);
      const def = defOf(type);
      if (!def) { list.push({ nodeId: n.id, label, message: `unknown node type "${type}"` }); continue; }
      if (def.kind !== 'trigger' && !edges.some((e) => e.target === n.id)) {
        list.push({ nodeId: n.id, label, message: 'no input connected' });
      }
      for (const p of def.properties ?? []) {
        if (p.required) {
          const v = (n.data as any).params?.[p.key];
          if (v === undefined || v === null || String(v).trim() === '') {
            list.push({ nodeId: n.id, label, message: `required field empty: ${p.displayName}` });
          }
        }
      }
    }
    return list;
  }, [nodes, edges, defOf]);

  const selectedRun = useMemo(() => {
    if (!selected || !runResult?.results) return null;
    const self = runResult.results.find((r: any) => r.nodeId === selected.id);
    if (!self) return null;
    const byId = new Map<string, any>(runResult.results.map((r: any) => [r.nodeId, r]));
    // Stored results hold each node's outputs; a node's inputs are its
    // predecessors' outputs (branch outputs are merged in stored results).
    const inputs = edges
      .filter((e) => e.target === selected.id)
      .flatMap((e) => byId.get(e.source)?.items ?? []);
    return { self, inputs };
  }, [selected, runResult, edges]);

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
    if (r.error) {
      setRunResult({ status: 'blocked', error: r.error, results: [] });
      return;
    }
    setRunResult(r);
    const statusByNode: Record<string, string> = {};
    const errorByNode: Record<string, string> = {};
    for (const nr of r.results ?? []) { statusByNode[nr.nodeId] = nr.status; if (nr.error) errorByNode[nr.nodeId] = nr.error; }
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: statusByNode[n.id], error: errorByNode[n.id] } })));
  };

  const newWorkflow = async () => {
    setCurrentId(null); setNodes([]); setEdges([]); setName('Untitled workflow'); setRunResult(null); setActive(true); setCollapsed([]);
  };

  const [wfMenu, setWfMenu] = useState<string | null>(null);

  const deleteWorkflow = async (wfId: string) => {
    const wf = workflows.find((w) => w.id === wfId);
    if (!confirm(`Delete workflow "${wf?.name ?? wfId}"? This cannot be undone (export first if needed).`)) return;
    await api(`/api/workflows/${wfId}`, { method: 'DELETE' });
    setWorkflows(await api('/api/workflows'));
    if (currentId === wfId) {
      setCurrentId(null); setNodes([]); setEdges([]); setName('Untitled workflow');
      setRunResult(null); setActive(true); setCollapsed([]);
    }
    setWfMenu(null);
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

  const openSettings = async () => {
    const s = await api('/api/settings/mcp');
    setMcp(s);
    setDraftUrl(s.flowforgeUrl);
    setDraftDisabled(s.disabledTools ?? []);
    setCopied(false);
    setShowSettings(true);
  };

  const saveSettings = async () => {
    const s = await api('/api/settings/mcp', { method: 'PUT', body: JSON.stringify({ flowforgeUrl: draftUrl, disabledTools: draftDisabled }) });
    setMcp(s);
    setDraftUrl(s.flowforgeUrl);
    setDraftDisabled(s.disabledTools ?? []);
  };

  const toggleTool = (name: string) =>
    setDraftDisabled((ds) => (ds.includes(name) ? ds.filter((t) => t !== name) : [...ds, name]));

  const copyText = async (t: string) => {
    try { await navigator.clipboard.writeText(t); } catch {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const mcpJsonSnippet = mcp ? JSON.stringify({ mcpServers: { flowforge: { command: mcp.command, args: mcp.args, env: { FLOWFORGE_URL: draftUrl || mcp.flowforgeUrl } } } }, null, 2) : '';
  const mcpClaudeCmd = mcp ? `claude mcp add flowforge -e FLOWFORGE_URL=${draftUrl || mcp.flowforgeUrl} -- node ${mcp.distPath}` : '';

  const TOOL_BLURBS: Record<string, string> = {
    list_nodes: 'Browse the node catalog', describe_node: 'Read a node’s parameter schema',
    find_node: 'Plain-language node search',
    list_workflows: 'List workflows', get_workflow: 'Read a workflow definition',
    create_workflow: 'Create workflows', update_workflow: 'Edit workflows', delete_workflow: 'Delete workflows',
    run_workflow: 'Execute workflows', test_node: 'Run a single node',
    create_custom_node: 'Author new nodes', delete_custom_node: 'Delete custom nodes',
    rollback_custom_node: 'Restore a prior version', set_custom_node_enabled: 'Kill switch',
    export_workflow: 'Export workflow JSON', import_workflow: 'Import workflow JSON',
    list_executions: 'Read run history',
  };

  const openNewCustom = () => {
    setEditing({ key: '', displayName: '', description: '', docAction: '', docTarget: '', docOutput: '', category: 'custom', icon: '', permHosts: '', permKv: false, permFiles: false, limTimeout: 10000, limMax: 10000, examplesText: '[]', properties: '[]', code: '// items: [{ json }], params: your fields\nreturn items.map(i => ({ json: { ...i.json } }));' });
    setEditError(null);
    setEditTestResult(null);
    setEditSaveResult(null);
    setEditVersions([]);
    setSimilar([]);
    setCustomTestInput('[{"json":{}}]');
  };

  const openEditCustom = async (key: string) => {
    const rows: any[] = await api('/api/custom-nodes');
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const perms = row.permissions && typeof row.permissions === 'object' ? row.permissions : {};
    const lims = row.limits && typeof row.limits === 'object' ? row.limits : {};
    const docs = row.docs && typeof row.docs === 'object' ? row.docs : {};
    setEditing({ ...row, properties: JSON.stringify(row.properties ?? [], null, 2), permHosts: (perms.network ?? []).join('\n'), permKv: !!perms.kv, permFiles: !!perms.files, limTimeout: lims.timeoutMs ?? 10000, limMax: lims.maxItems ?? 10000, examplesText: JSON.stringify(row.examples ?? [], null, 2), docAction: docs.action ?? '', docTarget: docs.target ?? '', docOutput: docs.output ?? '' });
    setEditError(null);
    setEditTestResult(null);
    setEditSaveResult(null);
    setCustomTestInput('[{"json":{}}]');
    const vers: any[] = await api(`/api/custom-nodes/${key}/versions`);
    setEditVersions(vers);
    setSimilar([]);
  };

  const editingPermissions = () => ({
    network: String(editing.permHosts ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
    kv: !!editing.permKv,
    files: !!editing.permFiles,
  });

  const saveCustom = async () => {
    setEditError(null);
    setEditSaveResult(null);
    let properties: any = [];
    try {
      properties = editing.properties.trim() ? JSON.parse(editing.properties) : [];
      if (!Array.isArray(properties)) throw new Error('properties must be an array');
    } catch (e) { setEditError(`Bad properties JSON: ${(e as Error).message}`); return; }
    let examples: any = [];
    try {
      examples = editing.examplesText.trim() ? JSON.parse(editing.examplesText) : [];
      if (!Array.isArray(examples)) throw new Error('examples must be an array');
    } catch (e) { setEditError(`Bad examples JSON: ${(e as Error).message}`); return; }
    const r = await api('/api/custom-nodes', {
      method: 'POST',
      body: JSON.stringify({ key: editing.key, displayName: editing.displayName, description: editing.description, category: editing.category || 'custom', icon: editing.icon || '', permissions: editingPermissions(), examples, limits: { timeoutMs: Number(editing.limTimeout) || 10000, maxItems: Number(editing.limMax) || 10000 }, docs: { action: editing.docAction || undefined, target: editing.docTarget || undefined, output: editing.docOutput || undefined }, author: 'human', properties, code: editing.code }),
    });
    if (r.error) { setEditError(r.error); return; }
    setEditSaveResult(r);
    await refreshNodes();
    if (editing.key) {
      const vers: any[] = await api(`/api/custom-nodes/${editing.key}/versions`);
      setEditVersions(vers);
      const rows: any[] = await api('/api/custom-nodes');
      const row = rows.find((x) => x.key === editing.key);
      if (row) setEditing((ed: any) => ({ ...ed, status: row.status, author: row.author, version: row.version }));
    }
  };

  const approveCustom = async () => {
    setEditError(null);
    const r = await api(`/api/custom-nodes/${editing.key}/approve`, { method: 'POST', body: JSON.stringify({ by: 'human' }) });
    if (r.error) { setEditError(r.error); return; }
    setEditing((ed: any) => ({ ...ed, status: 'approved' }));
    await refreshNodes();
  };

  const rollbackCustom = async (version: number) => {
    if (!confirm(`Roll back "${editing.key}" to v${version}? Current code becomes a newer version.`)) return;
    const r = await api(`/api/custom-nodes/${editing.key}/rollback`, { method: 'POST', body: JSON.stringify({ version, author: 'human' }) });
    if (r.error) { setEditError(r.error); return; }
    await openEditCustom(editing.key);
    await refreshNodes();
  };

  const toggleCustomEnabled = async (key: string, enabled: boolean) => {
    await api(`/api/custom-nodes/${key}/enable`, { method: 'POST', body: JSON.stringify({ enabled }) });
    await refreshNodes();
  };

  const deleteCustom = async (key: string) => {
    if (!confirm(`Delete custom node "${key}"? Workflows using it will fail until fixed.`)) return;
    await api(`/api/custom-nodes/${key}`, { method: 'DELETE' });
    await refreshNodes();
  };

  const exportCustom = async (key: string) => {
    const rows: any[] = await api('/api/custom-nodes');
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const blob = new Blob([JSON.stringify(row, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${key}.custom-node.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importCustom = async (file: File) => {
    try {
      const doc = JSON.parse(await file.text());
      const r = await api('/api/custom-nodes', { method: 'POST', body: JSON.stringify(doc) });
      if (r.error) throw new Error(r.error);
      await refreshNodes();
    } catch (e) {
      alert(`Node import failed: ${(e as Error).message}`);
    }
  };

  const editReuse = useMemo(
    () => (editing ? nodeDefs.find((d) => d.key === editing.key)?.trust?.reusability : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing?.key, nodeDefs],
  );

  // Reuse-before-create: suggest similar existing nodes while naming a new one.
  useEffect(() => {
    if (!editing || !showLibrary) return;
    const q = `${editing.displayName ?? ''} ${editing.description ?? ''}`.trim();
    if (q.length < 4) { setSimilar([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/nodes/search?${new URLSearchParams({ q, limit: '4' })}`);
        setSimilar((r ?? []).filter((n: any) => n.key !== editing.key));
      } catch { /* ignore */ }
    }, 500);
    return () => clearTimeout(t);
  }, [editing?.displayName, editing?.description, showLibrary]); // eslint-disable-line react-hooks/exhaustive-deps

  const testCustomDraft = async () => {
    setEditTestResult(null);
    let items: any;
    try {
      items = JSON.parse(customTestInput);
      if (!Array.isArray(items)) throw new Error('must be an array');
    } catch (e) { setEditTestResult({ error: `Bad test input: ${(e as Error).message}` }); return; }
    const params: any = {};
    try {
      const props = editing.properties.trim() ? JSON.parse(editing.properties) : [];
      for (const p of props) if (p.default !== undefined) params[p.key] = p.default;
    } catch { /* ignore */ }
    const r = await api('/api/custom-nodes/test', { method: 'POST', body: JSON.stringify({ code: editing.code, params, items, permissions: editingPermissions() }) });
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
        <button className="btn ghost" onClick={openSettings} title="Settings">⚙</button>
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
          {problems.length > 0 && (
            <div className="problems">
              <h2>⚠ Problems ({problems.length})</h2>
              {problems.slice(0, 8).map((p, i) => (
                <div key={i} className="problem-row" onClick={() => setSelectedId(p.nodeId)} title={p.label}>
                  <b>{p.label}</b> — {p.message}
                </div>
              ))}
              {problems.length > 8 && <div className="muted">…and {problems.length - 8} more</div>}
            </div>
          )}
          {paletteGroups.map(([cat, defs]) => (
            <div key={cat}>
              <button className="cat-head" onClick={() => toggleCat(cat)} title={collapsedCats.includes(cat) ? 'Expand' : 'Collapse'}>
                <span className="cat-arrow">{collapsedCats.includes(cat) ? '▸' : '▾'}</span>
                {catLabel(cat)}
                <span className="cat-count">{defs.length}</span>
              </button>
              {!collapsedCats.includes(cat) && defs.map((d) => <button key={d.key} className="node-btn" onClick={() => addNode(d)}>{d.displayName}<small>+</small></button>)}
            </div>
          ))}
          <h2>Workflows</h2>
          {workflows.map((w) => (
            <div key={w.id} className={`wf-item ${w.id === currentId ? 'active' : ''}`}>
              <span className="wf-name" onClick={() => { setCurrentId(w.id); setWfMenu(null); }}>{w.name}</span>
              <button className="wf-dots" onClick={(e) => { e.stopPropagation(); setWfMenu(wfMenu === w.id ? null : w.id); }} title="Workflow options">⋮</button>
              {wfMenu === w.id && (
                <div className="wf-menu">
                  <button onClick={() => deleteWorkflow(w.id)}>Delete workflow</button>
                </div>
              )}
            </div>
          ))}
        </aside>
        <div className="canvas">
          <ReactFlow
            nodes={visibleNodes} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            deleteKeyCode={['Backspace', 'Delete']}
            onNodeClick={(_, n) => { setSelectedId(n.id); setTestResult(null); }} onPaneClick={() => setSelectedId(null)} fitView
          >
            <Background color="#ddd" gap={16} /><Controls /><MiniMap />
          </ReactFlow>
        </div>
        <aside className="inspector" ref={inspectorRef} style={{ width: inspectorWidth }}>
          <div className="resize-gutter" onMouseDown={startResize} onDoubleClick={() => { setInspectorWidth(300); localStorage.setItem('ff.inspectorWidth', '300'); }} title="Drag to resize · double-click to reset" />
          {selected ? (
            <>
              <h3>{String((selected.data as any).label)}</h3>
              <div className="desc">{defOf((selected.data as any).type)?.description}</div>
              {defOf((selected.data as any).type)?.custom && defOf((selected.data as any).type)?.trust && (
                <div className="desc">
                  v{defOf((selected.data as any).type).trust.version} · {defOf((selected.data as any).type).trust.status} · by {defOf((selected.data as any).type).trust.author}
                  {defOf((selected.data as any).type).trust.reusability && ` · ♻ ${defOf((selected.data as any).type).trust.reusability.score} ${defOf((selected.data as any).type).trust.reusability.grade}`}
                </div>
              )}
              {defOf((selected.data as any).type)?.custom && (
                <div style={{ marginBottom: 12 }}>
                  <button className="btn ghost" onClick={() => { openEditCustom((selected.data as any).type); setShowLibrary(true); }}>Edit code in Library →</button>
                </div>
              )}
              {(defOf((selected.data as any).type)?.properties ?? []).map((p: any) => {
                const exprKey = `${selected.id}:${p.key}`;
                const isExpr = exprKeys.includes(exprKey);
                const exprHint = ['string', 'number', 'json', 'code', 'file'].includes(p.type);
                return (
                <label key={p.key} className="field">
                  <span className="field-head">{p.displayName}
                    {exprHint && (
                      <button type="button" className={`expr-btn ${isExpr ? 'on' : ''}`} title="Toggle expression mode ({{ $json.x }})"
                        onClick={(e) => { e.preventDefault(); toggleExpr(selected.id, p.key); }}>{'{{}}'}</button>
                    )}
                  </span>
                  {isExpr && <small className="muted expr-hint">{'{{ $json.field }} · {{ $vars.x }} · {{ $params.y }} — full JS, per item'}</small>}
                  {p.type === 'options' ? (
                    <select value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, e.target.value)}>
                      {p.options.map((o: any) => <option key={String(o.value)} value={o.value}>{o.name}</option>)}
                    </select>
                  ) : p.type === 'boolean' ? (
                    <button type="button" className={`switch ${((selected.data as any).params?.[p.key] ?? p.default) ? 'on' : ''}`}
                      onClick={() => setParam(p, !((selected.data as any).params?.[p.key] ?? p.default))}>
                      <span className="knob" />
                    </button>
                  ) : p.type === 'file' ? (
                    <FileField value={(selected.data as any).params?.[p.key] ?? ''} onChange={(v) => setParam(p, v)}
                      scope={p.fileScope ?? 'sandbox'} nodeKey={(selected.data as any).type} />
                  ) : p.type === 'code' && defOf((selected.data as any).type)?.custom ? (
                    <textarea rows={3} value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, e.target.value)} placeholder="Value for this run — implementation lives in the Library" />
                  ) : p.type === 'code' || p.type === 'json' ? (
                    <textarea rows={p.type === 'code' ? 8 : 4} value={String((selected.data as any).params?.[p.key] ?? '')} onChange={(e) => setParam(p, e.target.value)} spellCheck={false} />
                  ) : p.type === 'number' ? (
                    <input type="number" value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, Number(e.target.value))} />
                  ) : (
                    <input value={(selected.data as any).params?.[p.key] ?? ''} onChange={(e) => setParam(p, e.target.value)} />
                  )}
                </label>
                );
              })}
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
              {selectedRun && (
                <>
                  <h3 style={{ marginTop: 20 }}>Last run — {selectedRun.self.status}{selectedRun.self.durationMs != null ? ` · ${selectedRun.self.durationMs}ms` : ''}</h3>
                  {selectedRun.self.error && <div className="noderun err"><span className="err-text">{selectedRun.self.error}</span></div>}
                  <div className="noderun">
                    <b>Input</b> ({selectedRun.inputs.length} items)
                    <pre className="run" style={{ maxHeight: 160 }}>{JSON.stringify(selectedRun.inputs.slice(0, 3).map((it: any) => it.json), null, 2)}</pre>
                  </div>
                  <div className="noderun">
                    <b>Output</b> ({selectedRun.self.items?.length ?? 0} items)
                    <pre className="run" style={{ maxHeight: 160 }}>{JSON.stringify((selectedRun.self.items ?? []).slice(0, 3).map((it: any) => it.json), null, 2)}</pre>
                  </div>
                </>
              )}
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
              {runResult.error && <div className="error">{runResult.error}</div>}
              {runResult.trust?.testedUnapproved?.length > 0 && (
                <div className="desc">Unapproved nodes ran (manual only): {runResult.trust.testedUnapproved.join(', ')}</div>
              )}
              <pre className="run">{JSON.stringify(runResult.results?.map((r: any) => ({ node: r.nodeId, status: r.status, error: r.error, items: r.items?.length })), null, 2)}</pre>
            </>
          )}
        </aside>
      </div>
      {wfMenu && <div className="menu-scrim" onClick={() => setWfMenu(null)} />}

      {showSettings && (
        <div className="overlay" onClick={() => setShowSettings(false)}>
          <div className="library settings" onClick={(e) => e.stopPropagation()}>
            <div className="lib-head">
              <h2>Settings — AI agent setup (MCP)</h2>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setShowSettings(false)}>Close</button>
            </div>
            {!mcp ? <p className="muted">Loading…</p> : (
              <>
                <div className={`status-card ${mcp.built ? 'ok' : 'warn'}`}>
                  {mcp.built
                    ? `MCP server built — ${mcp.tools.filter((t: any) => t.enabled).length}/${mcp.tools.length} tools enabled. Restart the MCP client after changing settings.`
                    : <>MCP server not built. Run <code>pnpm --filter @flowforge/mcp build</code>, then reopen this page.</>}
                </div>
                <h3>Public URL</h3>
                <div className="desc">Baked into the client snippets below as FLOWFORGE_URL. Use your LAN/tunnel address if the agent runs on another machine.</div>
                <div className="row">
                  <input value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder="http://localhost:3000" />
                  <button className="btn" onClick={saveSettings}>Save</button>
                </div>
                <h3>Connect a client</h3>
                <div className="row">
                  <select value={settingsClient} onChange={(e) => setSettingsClient(e.target.value)}>
                    <option value="claude-code">Claude Code (CLI)</option>
                    <option value="claude-desktop">Claude Desktop</option>
                    <option value="generic">Generic (JSON)</option>
                  </select>
                  <button className="btn" onClick={() => copyText(settingsClient === 'claude-code' ? mcpClaudeCmd : mcpJsonSnippet)}>
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <pre className="snippet">{settingsClient === 'claude-code' ? mcpClaudeCmd : mcpJsonSnippet}</pre>
                <div className="desc">Flowforge itself must be running first — the MCP server probes it and refuses to start otherwise.</div>
                <h3>Tools exposed to agents</h3>
                <div className="desc">Uncheck to hide a tool. Takes effect when the MCP server (re)starts.</div>
                <div className="tool-grid">
                  {mcp.tools.map((t: any) => (
                    <label key={t.name} className={`tool-check ${draftDisabled.includes(t.name) ? 'off' : ''}`}>
                      <input type="checkbox" checked={!draftDisabled.includes(t.name)} onChange={() => toggleTool(t.name)} />
                      <span><b>{t.name}</b><br /><small className="muted">{TOOL_BLURBS[t.name] ?? ''}</small></span>
                    </label>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={saveSettings}>Save settings</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showLibrary && (
        <div className="overlay" onClick={() => { setShowLibrary(false); setEditing(null); }}>
          <div className="library" onClick={(e) => e.stopPropagation()}>
            <div className="lib-head">
              <h2>Node Library</h2>
              <div className="spacer" />
              {!editing && <>
                <button className="btn primary" onClick={openNewCustom}>+ New node</button>
                <label className="btn ghost" style={{ cursor: 'pointer' }}>Import
                  <input type="file" accept=".json,application/json" style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) importCustom(f); e.target.value = ''; }} />
                </label>
              </>}
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
                  <div className="field"><span>Structured docs — Action + Target + Output shape (agents + search use this)</span>
                    <label className="field"><span>Action</span>
                      <input value={editing.docAction ?? ''} onChange={(e) => setEditing({ ...editing, docAction: e.target.value })} placeholder="Fetches price of" /></label>
                    <label className="field"><span>Target</span>
                      <input value={editing.docTarget ?? ''} onChange={(e) => setEditing({ ...editing, docTarget: e.target.value })} placeholder="Bitcoin (CoinGecko)" /></label>
                    <label className="field"><span>Output shape</span>
                      <input value={editing.docOutput ?? ''} onChange={(e) => setEditing({ ...editing, docOutput: e.target.value })} placeholder="appends btc_price to json" /></label>
                  </div>
                  {similar.length > 0 && (
                    <div className="similar">Similar existing — reuse instead of creating?
                      {similar.map((s: any) => <div key={s.key} className="muted">• <b>{s.key}</b> — {s.reasons?.slice(0, 2).join('; ')}</div>)}
                    </div>
                  )}
                  <label className="field"><span>Category</span>
                    <input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="custom" /></label>
                  <label className="field"><span>Icon — emoji, or upload a picture (shown left of the node)</span>
                    <div className="row">
                      <input value={editing.icon ?? ''} onChange={(e) => setEditing({ ...editing, icon: e.target.value })} placeholder="✉️" />
                      <label className="btn ghost" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>Upload
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            if (f.size > 200_000) { alert('Image too large — max ~200KB.'); e.target.value = ''; return; }
                            const rd = new FileReader();
                            rd.onload = () => setEditing((ed: any) => ({ ...ed, icon: String(rd.result ?? '') }));
                            rd.readAsDataURL(f);
                            e.target.value = '';
                          }} />
                      </label>
                      {editing.icon && <button className="btn ghost" onClick={() => setEditing({ ...editing, icon: '' })}>Clear</button>}
                    </div>
                    {editing.icon && <div className="icon-preview"><NodeIcon icon={editing.icon} custom /><small className="muted">preview</small></div>}
                  </label>
                  <label className="field"><span>Properties (JSON array of fields shown in the inspector)</span>
                    <React.Suspense fallback={<CodeFieldFallback height={130} />}>
                      <CodeField height={130} language="json" path="custom-props" value={editing.properties} onChange={(v) => setEditing({ ...editing, properties: v })} />
                    </React.Suspense></label>
                  <div className="field"><span>Permissions — capabilities granted to the code (none by default)</span>
                    <label className="field"><span>Network hosts, one per line (code gets <code>fetch</code>)</span>
                      <textarea rows={2} value={editing.permHosts ?? ''} onChange={(e) => setEditing({ ...editing, permHosts: e.target.value })} placeholder={'api.example.com\n*.example.com'} /></label>
                    <label className="check"><input type="checkbox" checked={!!editing.permKv} onChange={(e) => setEditing({ ...editing, permKv: e.target.checked })} /> Key-value store (<code>kv.get/set/del/getJson/setJson</code>, private to this node)</label>
                    <label className="check"><input type="checkbox" checked={!!editing.permFiles} onChange={(e) => setEditing({ ...editing, permFiles: e.target.checked })} /> Files (<code>files.read/write/list/del</code> under <code>data/custom/{editing.key || '<key>'}/</code>)</label>
                  </div>
                  <div className="field"><span>Blast-radius limits</span>
                    <div className="row">
                      <label className="field"><span>Timeout (ms, 1000–30000)</span>
                        <input type="number" value={editing.limTimeout ?? 10000} onChange={(e) => setEditing({ ...editing, limTimeout: e.target.value })} /></label>
                      <label className="field"><span>Max output items (1–10000)</span>
                        <input type="number" value={editing.limMax ?? 10000} onChange={(e) => setEditing({ ...editing, limMax: e.target.value })} /></label>
                    </div>
                  </div>
                  <label className="field"><span>Self-test examples — all must pass for status “tested” (pass = runs without error)</span>
                    <textarea rows={4} value={editing.examplesText ?? '[]'} onChange={(e) => setEditing({ ...editing, examplesText: e.target.value })}
                      placeholder='[{"name":"basic","params":{},"items":[{"json":{}}]}]' style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }} /></label>
                  {editError && <div className="error">{editError}</div>}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn primary" onClick={saveCustom}>Save node</button>
                    {editing.status && <span className={`badge dark status-${editing.status}`}>{editing.status}</span>}
                    {editReuse && <span className="badge reuse" title="Reusability score">♻ {editReuse.score} · {editReuse.grade}</span>}
                    {editing.version > 0 && <small className="muted">v{editing.version} · by {editing.author ?? 'human'}</small>}
                    <button className="btn ghost" onClick={() => setEditing(null)}>Close</button>
                  </div>
                  {editing.status === 'tested' && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn" onClick={approveCustom}>Approve for automatic runs</button>
                    </div>
                  )}
                  {editSaveResult && (
                    <div className="save-report">
                      Saved v{editSaveResult.version} → <b>{editSaveResult.status}</b>
                      {(editSaveResult.report ?? []).map((r: any, i: number) => (
                        <div key={i} className="muted">• {r.name}: {r.ok ? `ok (${r.items} items)` : `FAIL — ${r.error}`}</div>
                      ))}
                      {editSaveResult.status === 'draft' && <div className="muted">Add passing examples to reach “tested”.</div>}
                    </div>
                  )}
                  {editVersions.length > 0 && (
                    <>
                      <h3 style={{ marginTop: 16 }}>History</h3>
                      {editVersions.map((v: any) => (
                        <div key={v.version} className="version-row">
                          <span>v{v.version} · {v.status} · {v.author} · {String(v.created_at ?? '').slice(0, 16).replace('T', ' ')}</span>
                          <button className="btn ghost" onClick={() => rollbackCustom(v.version)}>Roll back</button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                <div className="editor-code">
                  <label className="field"><span>Code — <code>items</code> and <code>params</code> are in scope. Return items or <code>{'{ branches }'}</code>.</span>
                    <React.Suspense fallback={<CodeFieldFallback height={320} />}>
                      <CodeField height={320} language="javascript" path="custom-code" value={editing.code} onChange={(v) => setEditing({ ...editing, code: v })} />
                    </React.Suspense></label>
                  <label className="field"><span>Test input</span>
                    <React.Suspense fallback={<CodeFieldFallback height={110} />}>
                      <CodeField height={110} language="json" path="custom-test" value={customTestInput} onChange={setCustomTestInput} />
                    </React.Suspense></label>
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
                      <div className="lib-card-title node-row"><NodeIcon icon={d.icon} custom={d.custom} />{d.displayName}</div>
                      <div className="lib-badges">
                        <span className="badge">{d.kind}</span>
                        <span className="badge">{d.category ?? 'other'}</span>
                        {d.custom && <span className="badge dark">custom</span>}
                        {d.custom && d.trust && <span className={`badge dark status-${d.trust.status}`}>{d.trust.status}</span>}
                        {d.custom && d.trust?.disabled && <span className="badge dark">killed</span>}
                        {d.custom && d.trust?.reusability && <span className="badge reuse" title="Reusability score">♻ {d.trust.reusability.score} · {d.trust.reusability.grade}</span>}
                        {disabled.includes(d.key) && <span className="badge dark">hidden</span>}
                      </div>
                      <div className="lib-card-desc">{d.trust?.contract ?? d.description ?? <span className="muted">No description.</span>}</div>
                      <div className="lib-card-key muted">{d.key} · v{d.custom && d.trust ? d.trust.version : d.version}{d.custom && d.trust ? ` · by ${d.trust.author}` : ''}</div>
                      <div className="lib-card-actions">
                        <button className="btn ghost" disabled={disabled.includes(d.key) || d.trust?.disabled} onClick={() => { addNode(d); setShowLibrary(false); }}>Add</button>
                        <button className="btn ghost" onClick={() => toggleDisabled(d.key)}>{disabled.includes(d.key) ? 'Show' : 'Hide'}</button>
                        {d.custom && <>
                          <button className="btn ghost" onClick={() => openEditCustom(d.key)}>Edit</button>
                          <button className="btn ghost" onClick={() => exportCustom(d.key)}>Export</button>
                          <button className="btn ghost" onClick={() => toggleCustomEnabled(d.key, !!d.trust?.disabled)}>{d.trust?.disabled ? 'Re-enable' : 'Kill'}</button>
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
