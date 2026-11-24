import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import type { NeighborsVM } from '../src/panel/protocol';

const COL_GAP = 130;
const ROW_GAP = 54;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface GraphHandlers {
  open: (id: string) => void;
  focus: (id: string) => void;
  peek: (id: string | null) => void;
}

/** Граф соседей: вызывающие слева, символ в центре, вызываемые справа. Позиции считаем сами (как в макете). */
export class NeighborGraph {
  private cy: Core | null = null;
  private key = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly on: GraphHandlers,
  ) {}

  render(vm: NeighborsVM, changedPrefix = 'Δ '): void {
    const key = JSON.stringify(vm);
    if (key === this.key && this.cy) return;
    this.key = key;
    const byCol = new Map<number, typeof vm.nodes>();
    for (const n of vm.nodes) byCol.set(n.col, [...(byCol.get(n.col) ?? []), n]);
    const elements: ElementDefinition[] = [];
    for (const [col, nodes] of byCol) {
      nodes.sort((a, b) => a.label.localeCompare(b.label));
      nodes.forEach((n, i) => {
        elements.push({
          data: {
            id: n.id,
            label: (n.changed ? changedPrefix : '') + n.label,
            color: n.color ?? cssVar('--vscode-descriptionForeground', '#888'),
            center: n.col === 0 ? 1 : 0,
            changed: n.changed ? 1 : 0,
          },
          position: { x: col * COL_GAP, y: (i - (nodes.length - 1) / 2) * ROW_GAP },
        });
      });
    }
    for (const e of vm.edges)
      elements.push({
        data: {
          id: `${e.from}→${e.to}`,
          source: e.from,
          target: e.to,
          link: e.kind === 'call' ? 0 : 1,
        },
      });

    const fg = cssVar('--vscode-foreground', '#ccc');
    const bg = cssVar('--vscode-editor-background', '#1e1f24');
    const line = cssVar('--vscode-descriptionForeground', '#777');
    const font = cssVar('--vscode-editor-font-family', 'monospace');

    this.cy?.destroy();
    this.cy = cytoscape({
      container: this.container,
      elements,
      layout: { name: 'preset', fit: true, padding: 14 },
      minZoom: 0.4,
      maxZoom: 1.6,
      wheelSensitivity: 0.3,
      autoungrabify: true,
      boxSelectionEnabled: false,
      style: [
        {
          selector: 'node',
          style: {
            shape: 'round-rectangle',
            width: 104,
            height: 34,
            'background-color': bg,
            'border-width': 1.5,
            'border-color': 'data(color)',
            label: 'data(label)',
            color: fg,
            'font-family': font,
            'font-size': 11,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'ellipsis',
            'text-max-width': '94px',
          },
        },
        {
          selector: 'node[changed = 1]',
          style: {
            'background-color': 'rgba(242,166,90,0.16)',
            'border-color': '#F2A65A',
            'border-width': 2,
          },
        },
        {
          selector: 'node[center = 1]',
          style: {
            'background-color': '#8B7CF6',
            'border-width': 0,
            color: '#111114',
            'font-weight': 'bold',
            height: 42,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': line,
            'target-arrow-color': line,
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.7,
            'curve-style': 'taxi',
            'taxi-direction': 'horizontal',
            opacity: 0.8,
          },
        },
        {
          selector: 'edge[link = 1]',
          style: {
            'line-style': 'dashed',
            'line-color': '#A99BFF',
            'target-arrow-color': '#A99BFF',
          },
        },
      ],
    });
    this.cy.on('tap', 'node', (e) => this.on.open(e.target.id()));
    this.cy.on('dbltap', 'node', (e) => this.on.focus(e.target.id()));
    this.cy.on('mouseover', 'node', (e) => this.on.peek(e.target.id()));
    this.cy.on('mouseout', 'node', () => this.on.peek(null));
  }

  resize(): void {
    if (!this.cy) return;
    this.cy.resize();
    this.cy.fit(undefined, 14);
  }

  destroy(): void {
    this.cy?.destroy();
    this.cy = null;
    this.key = '';
  }
}
