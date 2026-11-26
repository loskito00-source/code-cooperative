import type { Shell, World } from "@cdb/sim";
import type { FloatingWindow } from "./windows.js";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Colorea un poco la salida: errores, avisos, éxitos e IPs. */
function paint(line: string): string {
  let html = escapeHtml(line);
  html = html.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g, '<span class="t-ip">$1</span>');
  if (/^(E:|✗|ERROR|bash:|.*orden no encontrada|.*Permission denied|.*No route|.*refused|.*unreachable)/i.test(line)) return `<span class="t-err">${html}</span>`;
  if (/^(⚠|.*FOUND)/.test(line)) return `<span class="t-warn">${html}</span>`;
  if (/^(✓|.*¡Listo!|.*active \(running\))/.test(line)) return `<span class="t-ok">${html}</span>`;
  return html;
}

/** Lo que se ve en una terminal compartida (partida en línea). */
export interface TermOut {
  lines: string[];
  clear?: boolean;
  prompt: string;
  secret?: boolean;
  hostname: string;
  /** Pantalla de top / tail -f (null = se cerró). */
  live?: string[] | null;
}

/** Terminal en línea: el anfitrión publica lo que pasa; el otro jugador manda lo que escribe. */
export interface TermLink {
  /** Anfitrión: cada salida se le muestra también al otro jugador. */
  publish?: (out: TermOut) => void;
  /** Espejo: lo que escribe va al anfitrión (que la corre en su terminal). */
  send?: (input: { text?: string; ctrl?: "c" }) => void;
  /** Los dos: lo que va escribiendo en la línea de comando (antes de Enter), para que el otro lo vea en vivo. */
  typing?: (text: string) => void;
}

/**
 * Ventana de terminal de un servidor: muestra la salida, una línea para escribir, historial con ↑/↓, Tab para
 * completar, Ctrl+C para cortar (top, tail -f) y Ctrl+L para limpiar.
 * En una partida en línea la terminal es compartida: la corre el anfitrión y los dos ven lo mismo.
 */
export class TerminalWindow {
  /** null en el espejo (los comandos los corre el anfitrión). */
  readonly shell: Shell | null;
  /** Lo último que salió (para mostrárselo al que abre la terminal después). */
  readonly recent: string[] = [];
  private remoteHistory: string[] = [];
  private readonly out: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private readonly liveEl: HTMLElement;
  private histIdx = -1;
  private timer: number | null = null;

  constructor(readonly win: FloatingWindow, world: World, serverId: string, private readonly onRun: () => void, private readonly link: TermLink = {}) {
    this.shell = link.send ? null : world.shell(serverId);
    win.el.classList.add("termwin");
    win.body.innerHTML = `
      <div class="term" tabindex="-1">
        <div class="term-out" aria-live="polite"></div>
        <pre class="term-live" hidden></pre>
        <label class="term-line"><span class="term-prompt"></span><input class="term-in" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Comando" /></label>
      </div>`;
    this.out = win.body.querySelector(".term-out")!;
    this.liveEl = win.body.querySelector(".term-live")!;
    this.promptEl = win.body.querySelector(".term-prompt")!;
    this.inputEl = win.body.querySelector(".term-in")!;
    if (this.shell) {
      this.print(this.shell.welcome());
      this.syncPrompt();
    }
    win.body.querySelector(".term")!.addEventListener("pointerup", () => {
      if (!window.getSelection()?.toString()) this.inputEl.focus();
    });
    this.inputEl.addEventListener("keydown", (e) => this.key(e));
    // la línea de comando es compartida: lo que escribe uno le aparece al otro mientras escribe
    this.inputEl.addEventListener("input", () => this.shareTyping());
    win.onShow = () => setTimeout(() => this.inputEl.focus(), 0);
  }

  private key(e: KeyboardEvent): void {
    if (!this.shell) return this.remoteKey(e);
    const sh = this.shell;
    if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this.interrupt();
      this.inputEl.value = "";
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      this.out.innerHTML = "";
      return;
    }
    if (sh.live && (e.key === "q" || e.key === "Escape")) {
      e.preventDefault();
      sh.interrupt();
      this.stopLive();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const text = this.inputEl.value;
      this.inputEl.value = "";
      this.histIdx = -1;
      this.link.typing?.("");
      this.exec(text);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (sh.pending) return;
      e.preventDefault();
      const h = sh.history;
      if (!h.length) return;
      if (e.key === "ArrowUp") this.histIdx = this.histIdx < 0 ? h.length - 1 : Math.max(0, this.histIdx - 1);
      else this.histIdx = this.histIdx < 0 ? -1 : this.histIdx + 1 >= h.length ? -1 : this.histIdx + 1;
      this.inputEl.value = this.histIdx < 0 ? "" : h[this.histIdx];
      this.shareTyping();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      this.complete();
    }
  }

  private shareTyping(): void {
    if (this.inputEl.type === "password") return; // las contraseñas no se muestran
    this.link.typing?.(this.inputEl.value);
  }

  /** En línea: lo que el otro jugador va escribiendo en la línea de comando. */
  showTyping(text: string): void {
    if (this.inputEl.type === "password") return;
    if (this.inputEl.value === text) return;
    const atEnd = this.inputEl.selectionStart === this.inputEl.value.length;
    this.inputEl.value = text;
    if (atEnd && document.activeElement === this.inputEl) this.inputEl.setSelectionRange(text.length, text.length);
  }

  /** Corre una línea (la escribió este jugador o, en línea, el otro) y la publica. */
  exec(text: string): void {
    const sh = this.shell;
    if (!sh) return;
    const res = sh.input(text);
    this.inputEl.value = ""; // lo que corrió el otro jugador también estaba en esta línea
    if (res.clear) {
      this.out.innerHTML = "";
      this.recent.length = 0;
    }
    this.print(res.lines);
    this.syncPrompt();
    this.link.publish?.({ lines: res.lines, clear: res.clear, prompt: sh.prompt(), secret: !!sh.pending?.secret, hostname: sh.server.hostname });
    if (sh.live) this.startLive();
    this.onRun();
  }

  /** Ctrl+C. */
  interrupt(): void {
    const sh = this.shell;
    if (!sh) return;
    const lines = sh.interrupt();
    this.print(lines);
    this.stopLive();
    this.syncPrompt();
    this.link.publish?.({ lines, prompt: sh.prompt(), hostname: sh.server.hostname, live: null });
  }

  /** Espejo: muestra lo que publicó el anfitrión. */
  show(out: TermOut): void {
    if (out.clear) this.out.innerHTML = "";
    this.print(out.lines);
    this.promptEl.textContent = out.prompt;
    this.inputEl.type = out.secret ? "password" : "text";
    this.win.titleEl.lastChild!.textContent = `${out.hostname} — terminal`;
    if (out.live === undefined) return;
    if (out.live) {
      this.liveEl.hidden = false;
      this.out.hidden = true;
      this.liveEl.innerHTML = out.live.map(paint).join("\n");
    } else {
      this.liveEl.hidden = true;
      this.out.hidden = false;
      this.scroll();
    }
  }

  /** Teclas en el espejo: el comando va al anfitrión; la respuesta llega por show(). */
  private remoteKey(e: KeyboardEvent): void {
    if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this.link.send?.({ ctrl: "c" });
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      this.out.innerHTML = "";
      return;
    }
    if (!this.liveEl.hidden && (e.key === "q" || e.key === "Escape")) {
      e.preventDefault();
      this.link.send?.({ ctrl: "c" });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const text = this.inputEl.value;
      this.inputEl.value = "";
      this.histIdx = -1;
      if (text.trim() && this.inputEl.type !== "password") this.remoteHistory.push(text);
      this.link.typing?.("");
      this.link.send?.({ text });
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const h = this.remoteHistory;
      if (!h.length) return;
      if (e.key === "ArrowUp") this.histIdx = this.histIdx < 0 ? h.length - 1 : Math.max(0, this.histIdx - 1);
      else this.histIdx = this.histIdx < 0 ? -1 : this.histIdx + 1 >= h.length ? -1 : this.histIdx + 1;
      this.inputEl.value = this.histIdx < 0 ? "" : h[this.histIdx];
      this.shareTyping();
    }
  }

  /** Tab: completa el comando o la ruta. */
  private complete(): void {
    if (!this.shell) return;
    const v = this.inputEl.value;
    const words = v.split(" ");
    const last = words.at(-1) ?? "";
    let options: string[];
    if (words.length === 1) options = [...this.shell.available()].filter((c) => c.startsWith(last));
    else {
      const slash = last.lastIndexOf("/");
      const dir = slash >= 0 ? last.slice(0, slash + 1) : "";
      const base = last.slice(slash + 1);
      const fs = this.shell.server.fs;
      const abs = this.shell.path(dir || ".");
      options = (fs.list(abs, base.startsWith(".")) ?? []).filter((n) => n.startsWith(base)).map((n) => dir + n + (fs.isDir(abs === "/" ? `/${n}` : `${abs}/${n}`) ? "/" : ""));
    }
    if (options.length === 1) {
      words[words.length - 1] = options[0] + (options[0].endsWith("/") ? "" : " ");
      this.inputEl.value = words.join(" ");
    } else if (options.length > 1) {
      const lines = [this.shell.prompt() + v, options.join("  ")];
      this.print(lines);
      this.link.publish?.({ lines, prompt: this.shell.prompt(), hostname: this.shell.server.hostname });
    }
    this.shareTyping();
  }

  private print(lines: string[]): void {
    if (!lines.length) return;
    this.recent.push(...lines);
    if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const div = document.createElement("div");
      div.innerHTML = paint(l) || "&nbsp;";
      frag.append(div);
    }
    this.out.append(frag);
    while (this.out.childElementCount > 600) this.out.firstElementChild!.remove();
    this.scroll();
  }

  private syncPrompt(): void {
    if (!this.shell) return;
    const p = this.shell.prompt();
    this.promptEl.textContent = p;
    this.inputEl.type = this.shell.pending?.secret ? "password" : "text";
    this.win.titleEl.lastChild!.textContent = `${this.shell.server.hostname} — terminal`;
  }

  private startLive(): void {
    this.liveEl.hidden = false;
    this.out.hidden = true;
    const draw = () => {
      const sh = this.shell!;
      if (!sh.live) {
        this.link.publish?.({ lines: [], prompt: sh.prompt(), hostname: sh.server.hostname, live: null });
        return this.stopLive();
      }
      const frame = sh.live.render();
      this.liveEl.innerHTML = frame.map(paint).join("\n");
      this.link.publish?.({ lines: [], prompt: sh.prompt(), hostname: sh.server.hostname, live: frame });
    };
    draw();
    this.timer = window.setInterval(draw, 500);
  }

  private stopLive(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.liveEl.hidden = true;
    this.out.hidden = false;
    this.scroll();
  }

  private scroll(): void {
    const box = this.win.body.querySelector(".term")!;
    box.scrollTop = box.scrollHeight;
  }

  focus(): void {
    this.inputEl.focus();
  }
}
