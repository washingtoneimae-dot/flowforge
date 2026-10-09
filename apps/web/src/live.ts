/** Pure live-run state for the canvas overlay. No DOM — tested with vitest. */

export type RunEvent =
  | { type: 'subscribed'; workflowId: string }
  | { type: 'run-start'; executionId: string; workflowId: string; startedAt: string }
  | { type: 'node-start'; executionId: string; nodeId: string; startedAt: string }
  | { type: 'node-finish'; executionId: string; nodeId: string; status: string; durationMs: number; items?: number; error?: string }
  | { type: 'run-finish'; executionId: string; status: string; finishedAt: string };

export interface LiveNode {
  status: string;
  durationMs?: number;
  items?: number;
  error?: string;
}

export interface LiveState {
  executionId: string | null;
  running: boolean;
  status: string | null;
  nodes: Record<string, LiveNode>;
}

export const initialLiveState: LiveState = { executionId: null, running: false, status: null, nodes: {} };

/** Fold one SSE event into live state. Events from other executions are adopted. */
export function applyRunEvent(prev: LiveState, ev: RunEvent): LiveState {
  switch (ev.type) {
    case 'subscribed':
      return prev;
    case 'run-start':
      return { executionId: ev.executionId, running: true, status: null, nodes: {} };
    case 'node-start':
      if (prev.executionId !== null && prev.executionId !== ev.executionId) {
        return { executionId: ev.executionId, running: true, status: null, nodes: { [ev.nodeId]: { status: 'running' } } };
      }
      return {
        ...prev,
        executionId: ev.executionId,
        running: true,
        nodes: { ...prev.nodes, [ev.nodeId]: { status: 'running' } },
      };
    case 'node-finish': {
      const base: LiveState =
        prev.executionId === ev.executionId
          ? prev
          : { executionId: ev.executionId, running: true, status: null, nodes: {} };
      return {
        ...base,
        nodes: {
          ...base.nodes,
          [ev.nodeId]: { status: ev.status, durationMs: ev.durationMs, items: ev.items, error: ev.error },
        },
      };
    }
    case 'run-finish':
      if (prev.executionId !== null && prev.executionId !== ev.executionId) return prev;
      return { ...prev, executionId: ev.executionId, running: false, status: ev.status };
    default:
      return prev;
  }
}
