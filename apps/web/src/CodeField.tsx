import { useRef, useState } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import './monacoSetup.js';

export default function CodeField({ value, onChange, language, height, path }: { value: string; onChange: (v: string) => void; language: string; height: number | string; path?: string }) {
  const [plain, setPlain] = useState(() => {
    try { return localStorage.getItem('ff.plainEditor') === '1'; } catch { return false; }
  });
  const togglePlain = (v: boolean) => {
    setPlain(v);
    try { localStorage.setItem('ff.plainEditor', v ? '1' : '0'); } catch { /* ignore */ }
  };
  // Mount-timing layout glitches (0-size container, late fonts) leave lines
  // overlapped. Re-run layout right after mount and once more on next paint.
  const handleMount: OnMount = (editor) => {
    editor.layout();
    requestAnimationFrame(() => {
      try { editor.layout(); } catch { /* disposed */ }
    });
  };
  return (
    <div className="monaco-wrap" style={{ height }}>
      <button className="editor-toggle" onClick={() => togglePlain(!plain)} title={plain ? 'Switch to rich editor' : 'Switch to plain textarea (fallback)'}>
        {plain ? 'rich' : 'plain'}
      </button>
      {plain ? (
        <textarea
          className="plain-code"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <Editor
          key={path ?? 'default'}
          height="100%"
          theme="vs-dark"
          language={language}
          path={path}
          value={value ?? ''}
          onMount={handleMount}
          onChange={(v) => onChange(v ?? '')}
          options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, padding: { top: 8 }, tabSize: 2, automaticLayout: true, wordWrap: 'on', fixedOverflowWidgets: true }}
        />
      )}
    </div>
  );
}
