import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  FlowVM,
  FromPanel,
  ImpactVM,
  NeighborsVM,
  NodeVM,
  PanelState,
  Tab,
  ToPanel,
} from '../src/panel/protocol';
import { NeighborGraph } from './graph';
import css from './styles.css';

const vscode = acquireVsCodeApi();
const send = (m: FromPanel) => vscode.postMessage(m);

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

function fmt(s: string | undefined, ...args: (string | number)[]): string {
  return (s ?? '').replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`,
  );
}

/** Маленький Markdown для объяснений: абзацы, списки, `код`, **жирный**, *курсив*. HTML экранируется заранее. */
function markdown(text: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const out: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
      const ordered = /^\s*\d+\./.test(lines[0]!);
      const items = lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^#{1,6}\s/.test(lines[0]!)) {
      out.push(`<p><strong>${inline(lines[0]!.replace(/^#+\s*/, ''))}</strong></p>`);
      if (lines.length > 1) out.push(`<p>${lines.slice(1).map(inline).join('<br>')}</p>`);
    } else out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

function Row({
  n,
  extra,
  onClick,
}: {
  n: NodeVM;
  extra?: preact.ComponentChildren;
  onClick?: () => void;
}) {
  return (
    <button
      class="row"
      onClick={onClick ?? (() => send({ type: 'open', id: n.id }))}
      title={n.summary ?? ''}
    >
      <span class="dot" style={{ background: n.color ?? 'var(--muted)' }} />
      <span class="col">
        <span class="title">
          {n.changed && <span class="delta">Δ</span>}
          <span class="name">{n.label}</span>
          {extra}
        </span>
        {n.summary && <span class="sum">{n.summary}</span>}
      </span>
      <span class="where">
        {n.file.split('/').pop()}:{n.line}
      </span>
    </button>
  );
}

function Neighbors({
  vm,
  s,
  legend,
}: {
  vm: NeighborsVM;
  s: Record<string, string>;
  legend: PanelState['legend'];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const graph = useRef<NeighborGraph | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    graph.current = new NeighborGraph(ref.current, {
      open: (id) => send({ type: 'open', id }),
      focus: (id) => send({ type: 'focus', id }),
      peek: setPeek,
    });
    const ro = new ResizeObserver(() => graph.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      graph.current?.destroy();
    };
  }, [vm.center === null]);
  useEffect(() => {
    if (vm.center) graph.current?.render(vm);
  }, [vm]);

  if (!vm.center) return <p class="muted">{s.placeCursor}</p>;
  const shown = vm.nodes.find((n) => n.id === (peek ?? vm.center))!;
  return (
    <>
      <div class="graph-wrap">
        <div class="graph-cols">
          <span>{s.callers}</span>
          <span>{s.symbol}</span>
          <span>{s.callees}</span>
        </div>
        <div id="graph" ref={ref} />
      </div>
      <div class="depth">
        {s.depth}
        {([1, 2] as const).map((d) => (
          <button
            class={vm.depth === d ? 'on' : ''}
            onClick={() => send({ type: 'depth', depth: d })}
          >
            {d}
          </button>
        ))}
      </div>
      <div class="peek">
        <div>
          {shown.changed && <span class="delta">Δ </span>}
          <span class="mono">{shown.label}</span>
          {shown.layerLabel && <span class="muted small"> · {shown.layerLabel}</span>}
        </div>
        <div class="muted">
          {shown.summary ?? s.noSummary}
          {shown.stale && ` (${s.outdated})`}
        </div>
        {!peek && (
          <div style={{ marginTop: '6px', display: 'flex', gap: '12px' }}>
            <button class="link" onClick={() => send({ type: 'explain', id: shown.id })}>
              {s.explainBtn}
            </button>
            <button class="link" onClick={() => send({ type: 'flow', id: shown.id })}>
              {s.showFlow}
            </button>
          </div>
        )}
      </div>
      {legend.length > 0 && (
        <div>
          <div class="section-title">{s.layers}</div>
          <div class="legend">
            {legend.map((l) => (
              <div>
                <span class="swatch" style={{ background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Impact({ vm, s }: { vm: ImpactVM; s: Record<string, string> }) {
  if (!vm.sha) return <p class="muted">{s.noCommit}</p>;
  return (
    <>
      <div class="card">
        <div class="section-title" style={{ margin: 0 }}>
          {s.lastCommit} <span class="mono">{vm.sha}</span>
        </div>
        {vm.subject && <div class="muted">{vm.subject}</div>}
        {!vm.changed.length && <div class="muted">{s.nothingChanged}</div>}
      </div>
      {vm.changed.length > 0 && (
        <div>
          <div class="section-title">{s.changedFns}</div>
          <div class="list">
            {vm.changed.map((n) => (
              <Row n={n} extra={<span class="tag">{s[n.kind]}</span>} />
            ))}
          </div>
        </div>
      )}
      {vm.affected.length > 0 && (
        <div>
          <div class="section-title">{s.affected}</div>
          <div class="list">
            {vm.affected.map((n) => (
              <Row n={n} extra={<span class="tag">{'↑'.repeat(n.depth)}</span>} />
            ))}
          </div>
        </div>
      )}
      {vm.stale.length > 0 && (
        <div>
          <div class="section-title">{s.staleList}</div>
          <div class="list">
            {vm.stale.map((n) => (
              <Row n={n} />
            ))}
          </div>
        </div>
      )}
      {vm.missing > 0 && <div class="foot">{fmt(s.missing, vm.missing)}</div>}
    </>
  );
}

function Search({ state }: { state: PanelState }) {
  const s = state.strings;
  const [q, setQ] = useState(state.search.query);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const id = setTimeout(() => send({ type: 'search', query: q }), 120);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <>
      <input
        ref={input}
        class="search"
        placeholder={s.searchPlaceholder}
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
      />
      <div class="list">
        {state.search.hits.map((n) => (
          <Row n={n} extra={n.bySummary ? <span class="tag">{s.bySummary}</span> : null} />
        ))}
        {q.trim() && !state.search.hits.length && <p class="muted">{s.noHits}</p>}
      </div>
    </>
  );
}

function Flow({ vm, s }: { vm: FlowVM | null; s: Record<string, string> }) {
  if (!vm) return <p class="muted">{s.noFlow}</p>;
  return (
    <>
      <div class="flow">
        {vm.steps.map((n, i) => (
          <>
            {n.via && <div class="via">{n.via}</div>}
            <div
              class={`step${i === vm.current ? ' current' : ''}`}
              style={{ marginLeft: `${Math.max(0, n.depth - 1) * 10}px` }}
            >
              <span
                class="knot"
                style={n.color && i !== vm.current ? { borderColor: n.color } : {}}
              />
              <Row n={n} />
            </div>
          </>
        ))}
      </div>
      <div class="foot">{s.flowHint}</div>
    </>
  );
}

function Explain({ vm, s }: { vm: PanelState['explain']; s: Record<string, string> }) {
  if (!vm) return <p class="muted">{s.noExplain}</p>;
  return (
    <div class="explain card">
      <h4>{vm.title}</h4>
      {vm.status === 'loading' && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }} class="muted">
          <span class="spinner" /> {s.explainLoading}
        </div>
      )}
      {vm.status === 'error' && (
        <div>
          <strong>{s.explainFailed}:</strong> <span class="muted">{vm.text}</span>
        </div>
      )}
      {vm.status === 'done' && (
        <div class="body" dangerouslySetInnerHTML={{ __html: markdown(vm.text) }} />
      )}
      {vm.status !== 'loading' && (
        <div
          class="foot"
          style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}
        >
          {vm.model && <span>{vm.model}</span>}
          {vm.cached && <span>· {s.explainCached}</span>}
          <button class="link" onClick={() => send({ type: 'explain', id: vm.id, force: true })}>
            {s.explainAgain}
          </button>
        </div>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState<PanelState | null>(null);
  useEffect(() => {
    const onMsg = (e: MessageEvent<ToPanel>) => {
      if (e.data?.type === 'state') setState(e.data.state);
    };
    window.addEventListener('message', onMsg);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);
  if (!state) return null;
  const s = state.strings;
  if (!state.hasGraph) return <p class="muted">{s.noGraph}</p>;
  const tabs: Tab[] = ['neighbors', 'impact', 'search', 'flow', 'explain'];
  return (
    <>
      <div class="head">
        <strong>Clewmap</strong>
        <span class={`status ${state.status.fresh ? 'ok' : 'behind'}`}>
          {state.status.fresh ? s.fresh : fmt(s.behind, state.status.outdated)}
          {state.status.sha && <span class="muted"> · {state.status.sha}</span>}
        </span>
      </div>
      <div class="tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            role="tab"
            aria-selected={state.tab === tab}
            class={state.tab === tab ? 'on' : ''}
            onClick={() => send({ type: 'tab', tab })}
          >
            {s[tab]}
          </button>
        ))}
      </div>
      {state.tab === 'neighbors' && <Neighbors vm={state.neighbors} s={s} legend={state.legend} />}
      {state.tab === 'impact' && <Impact vm={state.impact} s={s} />}
      {state.tab === 'search' && <Search state={state} />}
      {state.tab === 'flow' && <Flow vm={state.flow} s={s} />}
      {state.tab === 'explain' && <Explain vm={state.explain} s={s} />}
      <div class="foot">{s.local}</div>
    </>
  );
}

render(<App />, document.getElementById('app')!);
