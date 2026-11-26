/**
 * Ventana "Comandos": la referencia del juego, separada por categorías.
 * Riel a la izquierda (grupos → categorías), buscador arriba y una ficha por comando,
 * como las etiquetas de precio de un estante: firma grande en letra de código y la explicación debajo.
 */
import { FEATURES } from "@cdb/interpreter";
import { SUPPLIER, type World } from "@cdb/sim";
import { COMMANDS, type CommandDoc } from "./help.js";
import type { FloatingWindow } from "./windows.js";

interface Entry {
  /** Lo que se escribe (texto plano, se escapa). */
  sig: string;
  /** Explicación (texto plano, se escapa). */
  desc: string;
  /** Las constantes se muestran como fichas compactas. */
  constant?: boolean;
}

interface Category {
  id: string;
  label: string;
  /** Una frase que dice para qué sirve la categoría (HTML propio, no del jugador). */
  intro: string;
  entries: Entry[];
  /** Nota al final (HTML propio). */
  outro?: string;
}

interface Group {
  id: "robot" | "python" | "datos" | "servidores";
  label: string;
  cats: Category[];
}

const STORAGE_KEY = "cdb.commands.v1";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const DIRECTIONS = ["North", "South", "East", "West"];

function fromDocs(group: CommandDoc["group"]): Entry[] {
  const list: Entry[] = COMMANDS.filter((c) => c.group === group && !DIRECTIONS.includes(c.name)).map((c) => ({
    sig: c.signature,
    desc: c.description,
    constant: c.kind === "constant",
  }));
  // las cuatro direcciones van juntas en una sola ficha
  if (group === "Moverse") list.push({ sig: DIRECTIONS.join("  "), desc: "Direcciones: arriba, abajo, derecha e izquierda.", constant: true });
  return list;
}

function buildGroups(world: World): Group[] {
  const owned = new Set<string>(world.features);
  const syntaxChips = FEATURES.map((f) => `<span class="cmd-feat ${owned.has(f) ? "on" : ""}">${f}</span>`).join("");
  return [
    {
      id: "robot",
      label: "El robot",
      cats: [
        { id: "moverse", label: "Moverse", intro: "Recorrer la tienda. (0, 0) es la esquina de abajo a la izquierda.", entries: fromDocs("Moverse") },
        { id: "reponer", label: "Reponer", intro: "Sacar mercancía del almacén y llenar los estantes.", entries: fromDocs("Reponer") },
        { id: "caja", label: "Caja", intro: "Atender a los clientes: escanear, cobrar y dar la devuelta. Cada caja tiene su fila hacia el este y su cajero solo atiende esa fila. Clic en una caja la activa o la desactiva: inactiva no recibe clientes.",
          entries: fromDocs("Caja"),
          outro: "🧪 De noche, a cada caja activa llega siempre un cliente de prueba con productos. Sirve para probar el código del cajero: no mueve plata, no gasta productos y no queda en la base de datos. El tiquete sale marcado como prueba.",
        },
      ],
    },
    {
      id: "python",
      label: "Python",
      cats: [
        {
          id: "sintaxis",
          label: "Sintaxis",
          intro: `Toda la sintaxis viene desbloqueada desde el inicio. Lo que se compra en Mejoras es la tienda: estantes, un local más grande, marketing y el centro de datos.<span class="cmd-feats">${syntaxChips}</span>`,
          entries: [
            { sig: "[x * 2 for x in numeros]", desc: "Comprensión de listas: arma una lista nueva en una sola línea, aplicando algo a cada elemento." },
            { sig: "[p for p in productos if p != \"pan\"]", desc: "Con if al final, solo entran los que cumplen la condición." },
            { sig: "sum([price(p) for p in scan_item()])", desc: "Ejemplo en la caja: el total del cliente en una línea." },
            { sig: "[(x, y) for x in range(3) for y in range(2)]", desc: "Se pueden encadenar varios for (como bucles anidados). La variable del for solo existe dentro de los corchetes." },
          ],
        },
        { id: "funciones", label: "Funciones", intro: "Funciones de Python que siempre puedes usar.", entries: fromDocs("Python") },
        {
          id: "velocidad",
          label: "Velocidad",
          intro: "Entre menos código tenga un robot, más rápido trabaja. Cada ventana de robot dice cuántas instrucciones tiene y a qué velocidad va.",
          entries: [
            { sig: "20 instrucciones", desc: "Velocidad normal (×1). Con 10 va ×1,3 más rápido; con 4 o menos, el doble de rápido. Con 60 va a la mitad y con 80 o más, lo más lento." },
            { sig: "Qué cuenta", desc: "Cada instrucción: asignaciones, llamadas, if, while, for, def, return... Los comentarios y las líneas en blanco no cuentan, y partir o juntar líneas no cambia nada." },
            { sig: "import shared", desc: "También cuentan las funciones de shared.py que el robot usa, las que esas llaman y lo que shared ejecuta al importarse. Pasar el código a shared no lo hace más rápido." },
            { sig: "Se mide al ejecutar", desc: "La velocidad se fija cuando presionas ▶ Ejecutar. Si cambias el código, vuelve a ejecutar." },
            { sig: "El servidor también frena", desc: "Un bucle sin wait(), los ataques, el malware y el calor siguen haciendo más lentos a los robots de ese servidor." },
          ],
        },
        {
          id: "texto",
          label: "Texto y números",
          intro: "Formas de armar mensajes para print().",
          entries: [
            { sig: 'f"Total: {total}"', desc: "Mete el valor de una variable dentro del texto." },
            { sig: 'f"{precio:,}"', desc: "Con separador de miles: 1,234,567." },
            { sig: 'f"{x:.2f}"', desc: "Con 2 decimales: 2.50." },
            { sig: '"Total: " + str(total)', desc: "Para sumar texto con un número, primero conviértelo con str()." },
            { sig: 'print("Total:", total)', desc: "print() acepta varios valores separados por comas." },
          ],
        },
        {
          id: "depurar",
          label: "Depurar",
          intro: "Seguir el código línea por línea. Solo se detiene ese robot: la tienda sigue corriendo.",
          entries: [
            { sig: "Punto de parada", desc: "Clic a la izquierda del número de línea: el robot se detiene antes de esa línea." },
            { sig: "⤵ Paso  (F10)", desc: "Ejecuta una sola línea. Si el robot no está corriendo, lo arranca en la primera." },
            { sig: "⏸ Pausar / ▶ Continuar  (F8)", desc: "Detiene al robot en la próxima línea o lo deja seguir." },
            { sig: "Variables", desc: "La pestaña Variables muestra el valor de cada variable en ese momento." },
          ],
        },
      ],
    },
    {
      id: "datos",
      label: "Datos",
      cats: [
        {
          id: "cursor",
          label: "Base de datos",
          intro: "La conexión <code>cursor</code> ya está abierta. Los valores van con <code>%s</code> y en una tupla, nunca pegados al texto del SQL.",
          entries: [
            { sig: "cursor.execute(sql, (valor1, valor2))", desc: 'Ejecuta INSERT, UPDATE, DELETE o CREATE. Ejemplo: cursor.execute("INSERT INTO productos (nombre, cantidad) VALUES (%s, %s)", ("pan", 40)). Devuelve algo como "INSERT 0 1".' },
            { sig: "cursor.fetch(sql, (valores))", desc: 'Lista de filas; cada fila es un diccionario: fila["nombre"].' },
            { sig: "cursor.fetchrow(sql, (valores))", desc: "Solo la primera fila, o None." },
            { sig: "cursor.fetchval(sql, (valores))", desc: 'Un solo valor. Ejemplo: cursor.fetchval("SELECT precio FROM productos WHERE nombre = %s", ("pan",)).' },
            { sig: "cursor.executemany(sql, filas)", desc: "La misma sentencia para cada tupla de la lista." },
          ],
        },
        {
          id: "pandas",
          label: "pandas",
          intro: "<code>import pandas as pd</code>. Solo trae dos comandos: leer la hoja y elegir un rango. Lo demás lo haces tú con Python.",
          entries: [
            { sig: 'hoja = pd.read_excel("archivo.xlsx")', desc: "Lee la hoja de cálculo. print(hoja) la muestra con las letras de columna y los números de fila." },
            { sig: 'filas = hoja.select("A1", "G6")', desc: 'Las celdas de ese rango (también hoja.select("A1:G6")) como una lista con un diccionario por fila. Las claves son los encabezados de la fila 1, que no cuenta como dato.' },
            { sig: "hoja.last_cell", desc: 'La última celda con datos, p. ej. "G6". Con hoja.select("A1", hoja.last_cell) el mismo script sirve para todos los pedidos.' },
          ],
          outro: `<button class="cmd-replay replay-intro">Repetir la intro</button>`,
        },
        {
          id: "proveedor",
          label: "Proveedor",
          intro: `En el Navegador pides a ${esc(SUPPLIER.name)} por cajas de ${SUPPLIER.caseUnits}. Se paga al pedir; en 1 minuto llega un Excel <code>pedido_N.xlsx</code> a la carpeta entregas, siempre con la misma estructura.`,
          entries: [
            { sig: "Migrar el pedido", desc: 'En inventario.py: pd.read_excel("pedido_1.xlsx"), hoja.select(...), limpia con Python y súbelo con cursor.execute. Si el producto ya está en tu tabla, súmale la cantidad con UPDATE; si es nuevo, INSERT.' },
            { sig: "Productos premium", desc: "Chocolate, queso, miel, aceite y vino: cuestan más pero dejan más ganancia, los clientes los piden más y cada uno en los estantes trae más clientes. El proveedor del barrio no los trae." },
          ],
        },
      ],
    },
    {
      id: "servidores",
      label: "Servidores",
      cats: [
        {
          id: "rack",
          label: "El rack",
          intro: "El código de los robots corre en un servidor del cuarto 🖥 Servidores. Su CPU se reparte entre los robots: un bucle sin <code>wait()</code> la satura y todos van más lento.",
          entries: [
            { sig: "Clic en un puesto libre del rack", desc: "Montaje en primera persona: arrastra cada pieza a su lugar y conecta los cables. Luego «Cerrar tapa y encender»." },
            { sig: "Clic en un servidor", desc: "Abre su terminal (también desde el explorador, carpeta servidores)." },
            { sig: "Navegador → TecnoMercado", desc: "Compra piezas (llegan mañana en el camión), aire acondicionado y protección anti-DDoS." },
          ],
        },
        {
          id: "terminal",
          label: "Terminal",
          intro: "Escribe <code>help</code> en la terminal para ver todo. ↑/↓ historial, Tab completa, Ctrl+C corta, Ctrl+L limpia.",
          entries: [
            { sig: "ip addr add 10.0.0.10/24 dev eth0", desc: "Le da una IP al servidor." },
            { sig: "ip route add default via 10.0.0.1", desc: "Le dice por dónde salir a la red." },
            { sig: "apt install robot-agent", desc: "Instala el agente de los robots." },
            { sig: "systemctl enable --now robot-agent", desc: "Arranca el agente y lo deja encendido." },
            { sig: "robot attach 10.0.0.21", desc: "Conecta a Toño a este servidor (10.0.0.22 es Lupe)." },
            { sig: "top   ps   kill PID   sensors", desc: "Ver la carga, los procesos y la temperatura." },
            { sig: "grep \"Failed\" /var/log/auth.log | awk '{print $11}' | sort | uniq -c", desc: "Leer los logs y contar los intentos por IP." },
          ],
        },
        {
          id: "seguridad",
          label: "Seguridad",
          intro: "Desde el día 2 atacan los servidores (solo los frenan). Si denuncias la IP real del atacante en Navegador → Denuncias, ganas un bug bounty.",
          entries: [
            { sig: "passwd", desc: "Contraseña fuerte: 10 caracteres o más, con letras y números." },
            { sig: "apt install fail2ban", desc: "Bloquea a quien falla mucho al entrar." },
            { sig: "ufw enable   ufw deny from IP", desc: "Firewall: baja los DDoS y bloquea una IP." },
            { sig: "apt install clamav   freshclam   clamscan -r --remove /tmp", desc: "Antivirus. Actualiza las firmas cada día." },
            { sig: "nmap   whois   dig   geoiplookup", desc: "Quién es una IP y qué puertos tiene abiertos." },
            { sig: "strings   ss -tunap   curl   nc", desc: "Qué dice un programa y con quién habla." },
          ],
          outro: "Todas las IPs y sitios de «internet» del juego son ficticios.",
        },
      ],
    },
  ];
}

/** Escapa y convierte `código` en <code>. */
function prose(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function entryHtml(e: Entry, catLabel?: string): string {
  const desc = e.desc;
  return `<article class="cmd-tag">
      <div class="cmd-sig"><code>${esc(e.sig)}</code></div>
      <p class="cmd-desc">${prose(desc)}</p>${catLabel ? `<p class="cmd-from">${esc(catLabel)}</p>` : ""}
    </article>`;
}

function constantsHtml(list: Entry[]): string {
  if (!list.length) return "";
  return `<h3 class="cmd-sub">Constantes</h3><div class="cmd-consts">${list
    .map((e) => `<div class="cmd-const"><code>${esc(e.sig)}</code><span>${prose(e.desc)}</span></div>`)
    .join("")}</div>`;
}

export class CommandsWindow {
  private current = "moverse";
  private query = "";
  private readonly rail: HTMLElement;
  private readonly page: HTMLElement;
  private readonly search: HTMLInputElement;

  constructor(private readonly win: FloatingWindow, private readonly world: () => World) {
    try {
      this.current = localStorage.getItem(STORAGE_KEY) ?? this.current;
    } catch {
      /* sin almacenamiento */
    }
    win.body.innerHTML = `<div class="cmd">
        <label class="cmd-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Buscar un comando" aria-label="Buscar un comando" spellcheck="false"></label>
        <nav class="cmd-rail" aria-label="Categorías"></nav>
        <div class="cmd-page" tabindex="-1"></div>
      </div>`;
    this.rail = win.body.querySelector(".cmd-rail")!;
    this.page = win.body.querySelector(".cmd-page")!;
    this.search = win.body.querySelector("input")!;
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.search.value) {
        e.stopPropagation();
        this.search.value = "";
        this.query = "";
        this.render();
      }
    });
    this.rail.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-cat]")?.dataset.cat;
      if (!id) return;
      this.current = id;
      this.query = "";
      this.search.value = "";
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* sin almacenamiento */
      }
      this.render();
      this.page.scrollTop = 0;
    });
    win.onShow = () => this.render();
    this.render();
  }

  render(): void {
    const groups = buildGroups(this.world());
    const all = groups.flatMap((g) => g.cats.map((c) => ({ g, c })));
    if (!all.some(({ c }) => c.id === this.current)) this.current = all[0].c.id;
    const searching = this.query.length > 0;

    this.rail.innerHTML = groups
      .map(
        (g) => `<div class="cmd-group" data-group="${g.id}"><h4>${g.label}</h4>${g.cats
          .map((c) => `<button data-cat="${c.id}" class="${!searching && c.id === this.current ? "on" : ""}" ${!searching && c.id === this.current ? 'aria-current="true"' : ""}>${c.label}</button>`)
          .join("")}</div>`,
      )
      .join("");

    if (searching) {
      const q = this.query;
      const hits = all.flatMap(({ g, c }) =>
        c.entries.filter((e) => e.sig.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)).map((e) => ({ g, c, e })),
      );
      this.page.dataset.group = "";
      this.page.innerHTML = hits.length
        ? `<h2 class="cmd-title">${hits.length} ${hits.length === 1 ? "resultado" : "resultados"}</h2>${hits
            .map(({ g, c, e }) => `<div data-group="${g.id}">${entryHtml(e, `${g.label} › ${c.label}`)}</div>`)
            .join("")}`
        : `<p class="cmd-empty">Nada con «${esc(this.search.value.trim())}». Prueba con una parte del nombre, como <code>shelf</code> o <code>pago</code>.</p>`;
      return;
    }

    const { g, c } = all.find(({ c }) => c.id === this.current)!;
    this.page.dataset.group = g.id;
    const fns = c.entries.filter((e) => !e.constant);
    const consts = c.entries.filter((e) => e.constant);
    this.page.innerHTML = `<h2 class="cmd-title">${c.label}</h2>
      <p class="cmd-intro">${c.intro}</p>
      ${fns.map((e) => entryHtml(e)).join("")}
      ${constantsHtml(consts)}
      ${c.outro ? `<p class="cmd-outro">${c.outro}</p>` : ""}`;
  }
}
