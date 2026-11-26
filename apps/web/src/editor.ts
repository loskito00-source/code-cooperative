import { type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { pythonLanguage, python } from "@codemirror/lang-python";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, forceLinting, linter } from "@codemirror/lint";
import { Compartment, EditorState, Prec, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, keymap } from "@codemirror/view";
import { check, type Feature } from "@cdb/interpreter";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { COMMANDS } from "./help.js";

/** Colores de tiza sobre la pizarra. */
export const chalk = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "#f6c945" },
  { tag: [t.string], color: "#f5a3b8" },
  { tag: [t.number, t.bool, t.null], color: "#8fd8e6" },
  { tag: [t.comment], color: "#8d9c90", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#b9e88f" },
  { tag: [t.definition(t.variableName), t.definition(t.function(t.variableName))], color: "#ffffff", fontWeight: "600" },
  { tag: [t.variableName], color: "#eef0e6" },
  { tag: [t.propertyName], color: "#d6e2d9" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#c3cec5" },
]);

// ── línea en ejecución / con error ───────────────────────────
interface Marks {
  run: number | null;
  error: number | null;
  paused: number | null;
}
const setMarks = StateEffect.define<Marks>();

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const ranges = [];
      const doc = tr.state.doc;
      if (e.value.paused && e.value.paused <= doc.lines) {
        ranges.push(Decoration.line({ class: "cm-pausedline" }).range(doc.line(e.value.paused).from));
      } else if (e.value.error && e.value.error <= doc.lines) {
        ranges.push(Decoration.line({ class: "cm-errorline" }).range(doc.line(e.value.error).from));
      } else if (e.value.run && e.value.run <= doc.lines) {
        ranges.push(Decoration.line({ class: "cm-runline" }).range(doc.line(e.value.run).from));
      }
      deco = Decoration.set(ranges);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── puntos de parada (clic en el margen izquierdo) ─────────
class BreakpointMarker extends GutterMarker {
  toDOM(): Node {
    const d = document.createElement("div");
    d.className = "cm-bp";
    return d;
  }
}
const bpMarker = new BreakpointMarker();
/** Casilla vacía en cada línea, para poder hacer clic y ver el círculo al pasar el ratón. */
class EmptyMarker extends GutterMarker {
  toDOM(): Node {
    const d = document.createElement("div");
    d.className = "cm-bp-empty";
    return d;
  }
}
const emptyMarker = new EmptyMarker();
const toggleBp = StateEffect.define<number>();

const breakpoints = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(toggleBp)) continue;
      let has = false;
      set.between(e.value, e.value, () => {
        has = true;
      });
      set = has ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [bpMarker.range(e.value)] });
    }
    return set;
  },
});

const breakpointGutter = [
  breakpoints,
  gutter({
    class: "cm-bp-gutter",
    markers: (v) => v.state.field(breakpoints),
    lineMarker: () => emptyMarker,
    initialSpacer: () => bpMarker,
    domEventHandlers: {
      mousedown(view, line) {
        view.dispatch({ effects: toggleBp.of(line.from) });
        return true;
      },
    },
  }),
];

function breakpointLines(state: EditorState): number[] {
  const lines: number[] = [];
  state.field(breakpoints).between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

// ── autocompletado con los comandos del juego ───────────────
function commandCompletions(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return {
    from: word.from,
    options: COMMANDS.map((c) => ({
      label: c.name,
      type: c.kind === "constant" ? "constant" : "function",
      detail: c.signature,
      info: c.description,
      apply: c.kind === "function" ? `${c.name}(` : c.name,
    })),
    validFor: /^\w*$/,
  };
}

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  features: () => ReadonlySet<Feature>;
  onChange: (text: string) => void;
  onRun: () => void;
  /** Cambiaron los puntos de parada (números de línea). */
  onBreakpoints?: (lines: number[]) => void;
}

/** Un editor de CodeMirror por ventana. */
export class CodeEditor {
  readonly view: EditorView;
  private lastMarks: Marks = { run: null, error: null, paused: null };
  /** Edición compartida (Yjs): vacío en el modo local. */
  private readonly collab = new Compartment();

  constructor(private readonly opts: EditorOptions) {
    this.view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: opts.doc,
        extensions: [
          this.collab.of([]),
          breakpointGutter,
          basicSetup,
          python(),
          pythonLanguage.data.of({ autocomplete: commandCompletions }),
          syntaxHighlighting(chalk),
          marks,
          EditorState.tabSize.of(4),
          indentUnit.of("    "), // 4 espacios, como en Python
          // Prec.highest: si no, el Ctrl+Enter de CodeMirror (insertar línea) gana
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (this.opts.onRun(), true) }])),
          // Tab indenta y Shift+Tab quita indentación. Para salir del editor con el teclado: Esc y luego Tab.
          keymap.of([indentWithTab]),
          linter((view) => this.diagnostics(view), { delay: 400 }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.opts.onChange(u.state.doc.toString());
            const bpChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(toggleBp)));
            if (bpChanged || (u.docChanged && u.state.field(breakpoints).size > 0)) {
              this.opts.onBreakpoints?.(breakpointLines(u.state));
            }
          }),
        ],
      }),
    });
    // Al cambiar el zoom de la ventana (+/−) cambia el tamaño de la letra pero no siempre el del editor: CodeMirror
    // seguía con la altura de línea vieja y al seleccionar con el mouse caía en otra línea (tomaba más líneas).
    // Cada vez que cambia el tamaño del contenido, que vuelva a medir.
    new ResizeObserver(() => this.view.requestMeasure()).observe(this.view.contentDOM);
  }

  private diagnostics(view: EditorView): Diagnostic[] {
    const doc = view.state.doc;
    return check(doc.toString(), this.opts.features()).map((err) => {
      const line = doc.line(Math.max(1, Math.min(err.line, doc.lines)));
      return {
        from: line.from,
        to: line.to,
        severity: err.kind === "bloqueado" ? "warning" : "error",
        message: err.message.charAt(0).toUpperCase() + err.message.slice(1),
      };
    });
  }

  /** Resalta la línea en ejecución (verde), con error (rojo) o donde está pausado (amarillo). */
  setMarks(run: number | null, error: number | null, paused: number | null = null): void {
    const m = this.lastMarks;
    if (run === m.run && error === m.error && paused === m.paused) return;
    this.lastMarks = { run, error, paused };
    this.view.dispatch({ effects: setMarks.of(this.lastMarks) });
    const line = paused ?? error;
    if (line && line <= this.view.state.doc.lines) {
      this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.doc.line(line).from, { y: "nearest" }) });
    }
  }

  /**
   * Conecta el editor a un texto compartido (partida en línea): lo que escribe cada jugador aparece en vivo en el otro,
   * con su cursor y su nombre.
   */
  attachCollab(text: Y.Text, awareness: Awareness): void {
    const shared = text.toString();
    if (this.view.state.doc.toString() !== shared) {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: shared } });
    }
    this.view.dispatch({ effects: this.collab.reconfigure(yCollab(text, awareness, { undoManager: new Y.UndoManager(text) })) });
  }

  /** Vuelve a revisar desbloqueos (después de una compra). */
  relint(): void {
    forceLinting(this.view);
  }

  get text(): string {
    return this.view.state.doc.toString();
  }
}
