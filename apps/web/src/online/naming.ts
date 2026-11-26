/**
 * Ponerle nombre a los robots entre los dos jugadores: lo que escribe uno aparece en vivo en la pantalla del otro.
 * Al crear la partida se nombran Toño y Lupe (los de siempre); cuando se compra un robot o una caja, el nuevo.
 */
import type { Room } from "./room.js";

export interface RobotToName {
  id: string;
  role: "reponedor" | "cajero";
  name: string;
  color: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ROLE = { reponedor: "Surte los estantes", cajero: "Atiende la caja" };

function card(r: RobotToName): string {
  return `<label class="nm-robot" style="--c: var(--${r.color})">
      <span class="nm-dot" aria-hidden="true"></span>
      <span class="nm-role">${ROLE[r.role]}</span>
      <input data-robot="${r.id}" maxlength="16" value="${esc(r.name)}" spellcheck="false" />
    </label>`;
}

/**
 * Pantalla para nombrar a los robots al crear la partida. Termina cuando todos los que están en la sala dicen
 * "¡Listo!" (el anfitrión decide el final). Sin sala (modo local) termina con un solo "¡Listo!".
 */
export function nameRobotsTogether(room: Room | null, robots: RobotToName[], code: string | null): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const names: Record<string, string> = Object.fromEntries(robots.map((r) => [r.id, r.name]));
    const ready = new Set<string>();
    const box = document.createElement("div");
    box.className = "naming";
    box.innerHTML = `<div class="nm-card" role="dialog" aria-modal="true" aria-labelledby="nm-title">
        <p class="nm-kicker">${code ? `Partida <b>${esc(code)}</b>` : "Partida nueva"}</p>
        <h2 id="nm-title">¿Cómo se llaman los robots?</h2>
        <p class="nm-sub">${room ? "Escriban entre los dos: lo que uno escribe le aparece al otro." : "Pónganles el nombre que quieran."} Se puede cambiar después.</p>
        <div class="nm-robots">${robots.map(card).join("")}</div>
        <div class="nm-foot"><ul class="nm-players"></ul><button class="nm-ready">¡Listo!</button></div>
        ${code ? `<p class="nm-invite">Para que tu compañero entre: menú → Jugar en línea → código <b>${esc(code)}</b>.</p>` : ""}
      </div>`;
    document.body.append(box);
    const btn = box.querySelector<HTMLButtonElement>(".nm-ready")!;
    const players = box.querySelector<HTMLElement>(".nm-players")!;
    const offs: (() => void)[] = [];

    const paintPlayers = () => {
      if (!room) return;
      players.innerHTML = room.peers
        .map((p) => `<li class="${ready.has(p.id) ? "ok" : ""}" style="--c:${p.color}"><span class="nm-pdot"></span>${esc(p.name)}${p.id === room.me.id ? " (tú)" : ""} ${ready.has(p.id) ? "✓" : "…"}</li>`)
        .join("");
      btn.textContent = ready.has(room.me.id) ? "Esperando…" : "¡Listo!";
      btn.classList.toggle("waiting", ready.has(room.me.id));
    };

    const finish = (final: Record<string, string>) => {
      offs.forEach((f) => f());
      box.remove();
      resolve(final);
    };

    const checkAll = () => {
      if (!room) return;
      paintPlayers();
      if (room.isHost && room.peers.every((p) => ready.has(p.id))) {
        room.send("names-final", names);
        finish({ ...names });
      }
    };

    box.addEventListener("input", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-robot]");
      if (!input) return;
      names[input.dataset.robot!] = input.value;
      room?.send("names", { id: input.dataset.robot, v: input.value });
      if (room) {
        // si alguien cambia un nombre, los "listo" se reinician
        ready.clear();
        room.send("names-ready", { ready: false });
        paintPlayers();
      }
    });
    btn.addEventListener("click", () => {
      if (Object.values(names).some((n) => !n.trim())) {
        box.querySelector<HTMLInputElement>("input[data-robot]:placeholder-shown, input[data-robot]")!.focus();
        return;
      }
      if (!room) return finish({ ...names });
      const now = !ready.has(room.me.id);
      if (now) ready.add(room.me.id);
      else ready.delete(room.me.id);
      room.send("names-ready", { ready: now });
      checkAll();
    });

    if (room) {
      offs.push(
        room.on("names", (p: { id: string; v: string }) => {
          names[p.id] = p.v;
          const input = box.querySelector<HTMLInputElement>(`input[data-robot="${p.id}"]`);
          if (input && input.value !== p.v) input.value = p.v;
          ready.clear();
          paintPlayers();
        }),
        room.on("names-ready", (p: { ready: boolean }, from) => {
          if (p.ready) ready.add(from);
          else ready.delete(from);
          checkAll();
        }),
        room.on("names-final", (final: Record<string, string>) => finish(final)),
        // el que llega tarde pide cómo van los nombres
        room.on("names-get", (_p, from) => room.send("names-state", { names, ready: [...ready] }, from)),
        room.on("names-state", (p: { names: Record<string, string>; ready: string[] }) => {
          Object.assign(names, p.names);
          for (const [id, v] of Object.entries(p.names)) {
            const input = box.querySelector<HTMLInputElement>(`input[data-robot="${id}"]`);
            if (input) input.value = v;
          }
          p.ready.forEach((id) => ready.add(id));
          paintPlayers();
        }),
      );
      const prev = room.onPeers;
      room.onPeers = (peers) => {
        prev?.(peers);
        checkAll();
      };
      offs.push(() => (room.onPeers = prev));
      room.send("names-get", null);
      paintPlayers();
    }
    box.querySelector<HTMLInputElement>("input[data-robot]")?.select();
  });
}

/**
 * Llegó un robot nuevo (se compró un reponedor o una caja con su cajero): los dos le ponen nombre.
 * Cualquiera de los dos puede confirmar. Devuelve el nombre elegido.
 */
export function nameNewRobot(room: Room | null, robot: RobotToName): Promise<string> {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "naming small";
    box.innerHTML = `<form class="nm-card" role="dialog" aria-modal="true" aria-labelledby="nm-title-${robot.id}">
        <p class="nm-kicker">${robot.role === "cajero" ? "Caja nueva" : "Robot nuevo"}</p>
        <h2 id="nm-title-${robot.id}">¿Cómo se va a llamar?</h2>
        <div class="nm-robots">${card(robot)}</div>
        ${room ? `<p class="nm-sub">Tu compañero ve lo que escribes. Cualquiera de los dos puede confirmar.</p>` : ""}
        <div class="nm-foot"><span></span><button class="nm-ready">Ponerle el nombre</button></div>
      </form>`;
    document.body.append(box);
    const input = box.querySelector<HTMLInputElement>("input")!;
    const offs: (() => void)[] = [];
    const finish = (name: string) => {
      offs.forEach((f) => f());
      box.remove();
      resolve(name);
    };
    input.addEventListener("input", () => room?.send("hire-name", { id: robot.id, v: input.value }));
    box.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim() || robot.name;
      room?.send("hire-done", { id: robot.id, v: name });
      finish(name);
    });
    if (room) {
      offs.push(
        room.on("hire-name", (p: { id: string; v: string }) => {
          if (p.id === robot.id && input.value !== p.v) input.value = p.v;
        }),
        room.on("hire-done", (p: { id: string; v: string }) => {
          if (p.id === robot.id) finish(p.v);
        }),
      );
    }
    input.select();
  });
}
