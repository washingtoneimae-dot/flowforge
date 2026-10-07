import { Editor } from '@monaco-editor/react';
import './monacoSetup.js';

export default function CodeField({ value, onChange, language, height }: { value: string; onChange: (v: string) => void; language: string; height: number | string }) {
  return (
    <div className="monaco-wrap" style={{ height }}>
      <Editor
        height="100%"
        theme="vs-dark"
        language={language}
        value={value ?? ''}
        onChange={(v) => onChange(v ?? '')}
        options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, padding: { top: 8 }, tabSize: 2, automaticLayout: true }}
      />
    </div>
  );
}
