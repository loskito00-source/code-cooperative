import { FEATURES } from "@cdb/interpreter";
import { describe, expect, test } from "vitest";
import { type Shell, STARTER_KIT, World, tokenize } from "../src/index.js";

function mundo() {
  const w = new World(5);
  for (const f of FEATURES) w.features.add(f);
  w.customersEnabled = false;
  return w;
}

/** Corre comandos y devuelve la salida (sin la línea del prompt). */
function sh(shell: Shell, line: string): string[] {
  return shell.input(line).lines.slice(1);
}

/** Monta el kit del primer servidor en el puesto 0 y lo enciende. */
function montar(w: World) {
  for (const def of STARTER_KIT) {
    const part = w.parts.find((p) => p.def === def)!;
    expect(w.installPart(0, part.uid)).toEqual({ ok: true });
  }
  for (const c of ["atx24", "cpu8", "sata", "red"] as const) expect(w.connectCable(0, c)).toEqual({ ok: true });
  const r = w.powerOn(0);
  expect(r.post.ok).toBe(true);
  return r.server!;
}

describe("tutorial: montar el servidor, instalar Linux y conectar a los robots", () => {
  test("de las piezas en el almacén a los robots corriendo en srv-01", () => {
    const w = mundo();
    w.startServerTutorial();
    expect(w.servers).toHaveLength(0);
    expect(w.parts.map((p) => p.def).sort()).toEqual([...STARTER_KIT].sort());
    w.setScript("tono", "while True:\n    wait()\n");
    w.runRobot("tono");
    expect(w.robot("tono").console.at(-1)!.text).toBe("No se puede ejecutar: Toño no está conectado a ningún servidor.");

    const server = montar(w);
    expect(server).toMatchObject({ cores: 1, ramGb: 2, cable: true, os: null });
    const t = w.shell(server.id);
    expect(t.welcome()[1]).toContain("Instalador de Linux");
    expect(t.prompt()).toBe("Nombre del servidor (por ejemplo srv-01): ");
    t.input("srv-01");
    t.input("admin");
    expect(t.input("123").lines).toContain("Muy corta (mínimo 4 caracteres).");
    t.input("1234");
    expect(t.prompt()).toBe("Repite la contraseña: ");
    const done = t.input("1234").lines.join("\n");
    expect(done).toContain("¡Listo! Linux quedó instalado en srv-01.");
    expect(done).toContain("Tu contraseña es débil");
    expect(t.prompt()).toBe("admin@srv-01:~$ ");
    expect(sh(t, "cat LEEME.txt")[0]).toBe("Bienvenido a tu servidor.");

    // sin red no hay apt
    expect(sh(t, "apt install robot-agent")[0]).toContain("eth0 no tiene IP");
    expect(sh(t, "ping 10.0.0.1")[0]).toContain("eth0 no tiene IP");
    expect(sh(t, "ip addr add 10.0.0.21/24 dev eth0")[0]).toContain("ya la usa otro equipo");
    sh(t, "ip addr add 10.0.0.10/24 dev eth0");
    expect(sh(t, "ping 10.0.0.1")[0]).toBe("PING 10.0.0.1 (10.0.0.1)");
    expect(sh(t, "apt install robot-agent")[0]).toContain("falta la puerta de enlace");
    sh(t, "ip route add default via 10.0.0.1");
    expect(sh(t, "apt install robot-agent").join("\n")).toContain("systemctl enable --now robot-agent");
    expect(sh(t, "robot attach 10.0.0.21")[0]).toContain("robot-agent no está corriendo");
    sh(t, "systemctl enable --now robot-agent");
    expect(sh(t, "systemctl status robot-agent")[2]).toContain("active (running)");
    expect(sh(t, "robot attach 10.0.0.21")[0]).toBe("✓ Toño (10.0.0.21) ahora ejecuta su código en srv-01.");
    sh(t, "robot attach 10.0.0.22");

    w.runRobot("tono");
    for (let i = 0; i < 10; i++) w.step();
    expect(w.isRunning("tono")).toBe(true);
    expect(sh(t, "ps").some((l) => l.includes("python3 tono.py"))).toBe(true);
  });

  test("el POST explica qué falta, y el orden de montaje se respeta", () => {
    const w = mundo();
    w.startServerTutorial();
    const uid = (def: string) => w.parts.find((p) => p.def === def)!.uid;
    expect(w.installPart(0, uid("cpu-c1"))).toEqual({ ok: false, reason: "Primero va la placa madre: todo se conecta a ella." });
    w.installPart(0, uid("placa-am1"));
    expect(w.installPart(0, uid("cooler"))).toMatchObject({ ok: false, reason: expect.stringContaining("primero pon la CPU") });
    w.installPart(0, uid("psu-300"));
    expect(w.powerOn(0).post.lines.at(-1)).toContain("falta el cable de 24 pines");
    w.connectCable(0, "atx24");
    expect(w.powerOn(0).post.lines.at(-1)).toBe("✗ No se detecta la CPU.");
    w.installPart(0, uid("cpu-c1"));
    expect(w.connectCable(0, "sata")).toMatchObject({ ok: false });
    w.connectCable(0, "cpu8");
    expect(w.powerOn(0).post.lines.at(-1)).toContain("Falta el disipador");
    w.installPart(0, uid("cooler"));
    expect(w.powerOn(0).post.lines.at(-1)).toContain("No se detecta memoria RAM");
    w.installPart(0, uid("ram-2"));
    w.installPart(0, uid("ssd"));
    w.connectCable(0, "sata");
    const r = w.powerOn(0);
    expect(r.post.ok).toBe(true);
    expect(r.post.warnings).toEqual(["Sin cable de red: el servidor no tendrá conexión."]);
    const t = w.shell(r.server!.id);
    t.input("srv-01");
    t.input("admin");
    t.input("clave12345x");
    t.input("clave12345x");
    expect(sh(t, "ip addr add 10.0.0.10/24 dev eth0")).toEqual([]);
    expect(sh(t, "ping 10.0.0.1")[0]).toContain("no hay cable de red");
  });

  test("compatibilidad: socket distinto y fuente que no alcanza", () => {
    const w = mundo();
    w.money = 1_000_000;
    w.rackCapacity = 3; // la sala ya ampliada (Mejoras → Centro de datos)
    expect(w.order(["rack", "placa-am1", "cpu-t8", "gpu", "psu-300"])).toMatchObject({ ok: true });
    expect(w.parts).toHaveLength(0);
    w.deliver(true);
    const uid = (def: string) => w.parts.find((p) => p.def === def)!.uid;
    w.installPart(1, uid("placa-am1"));
    expect(w.installPart(1, uid("cpu-t8"))).toMatchObject({ ok: false, reason: "Esta CPU es LGA-2 y la placa es AM-1: no entra en el socket." });
    w.installPart(1, uid("gpu"));
    w.installPart(1, uid("psu-300"));
    w.connectCable(1, "atx24");
    expect(w.powerOn(1).post.lines.at(-1)).toBe("✗ No se detecta la CPU.");
    w.money = 0;
    expect(w.order(["cpu-r2"])).toEqual({ ok: false, reason: "no alcanza el dinero" });
  });

  test("empieza con un solo rack; los otros se compran (máximo 3)", () => {
    const w = mundo();
    w.startServerTutorial();
    expect(w.racksOwned).toBe(1);
    const part = w.parts[0];
    expect(w.installPart(1, part.uid)).toEqual({ ok: false, reason: "Ese puesto no tiene rack: cómpralo en TecnoMercado." });
    w.money = 1_000_000;
    expect(w.order(["rack"])).toEqual({ ok: false, reason: "en la sala solo cabe 1 rack: amplíala en Mejoras" });
    expect(w.buy("sala1")).toEqual({ ok: true });
    expect(w.buy("sala2")).toEqual({ ok: true });
    expect(w.order(["rack", "rack"])).toMatchObject({ ok: true });
    expect(w.order(["rack"])).toEqual({ ok: false, reason: "en la sala caben 3 racks" });
    expect(w.racksOwned).toBe(1); // llegan mañana
    w.deliver(true);
    expect(w.racksOwned).toBe(3);
    expect(w.installPart(2, part.uid)).toEqual({ ok: true });
  });

  test("las compras llegan a la mañana siguiente", () => {
    const w = mundo();
    w.money = 100_000;
    w.order(["ram-4", "aire"]);
    w.day = 2; // cerró el día 1
    w.startNight(1000);
    w.updateNight(1000); // amanece
    expect(w.parts.map((p) => p.def)).toContain("ram-4");
    expect(w.services.has("aire")).toBe(true);
  });
});

describe("terminal: comandos y tuberías", () => {
  test("tokenize respeta comillas", () => {
    expect(tokenize(`awk -F'"' '{print $6}' a.log`)).toEqual(["awk", '-F"', "{print $6}", "a.log"]);
    expect(tokenize(`grep "OR 1=1" x`)).toEqual(["grep", "OR 1=1", "x"]);
  });

  test("grep | awk | sort | uniq -c sobre un log", () => {
    const w = mundo();
    const t = w.shell("srv-01");
    const s = w.server("srv-01")!;
    s.fs.write("/var/log/prueba.log", "a 1.1.1.1\nb 2.2.2.2\nc 1.1.1.1\nd 3.3.3.3\n");
    expect(sh(t, "grep 1.1 /var/log/prueba.log | wc -l")).toEqual(["2"]);
    expect(sh(t, "awk '{print $2}' /var/log/prueba.log | sort | uniq -c | sort -nr | head -n 1")).toEqual(["      2 1.1.1.1"]);
    expect(sh(t, "cut -d ' ' -f 1 /var/log/prueba.log | head -n 2")).toEqual(["a", "b"]);
    expect(sh(t, "nmap 10.0.0.1")[0]).toBe("nmap: orden no encontrada. Instálala con: apt install nmap");
    expect(sh(t, "cd /var/log && pwd")).toEqual(["/var/log"]);
    expect(sh(t, "ls /nada")[0]).toContain("no existe");
  });

  test("top es en vivo y Ctrl+C lo corta", () => {
    const w = mundo();
    const t = w.shell("srv-01");
    t.input("top");
    expect(t.live).not.toBeNull();
    expect(t.live!.render()[0]).toMatch(/^top - /);
    t.interrupt();
    expect(t.live).toBeNull();
  });

  test("ssh a otro servidor con contraseña y exit para volver", () => {
    const w = mundo();
    w.startServerTutorial();
    const a = w.skipServerTutorial();
    w.money = 1e6;
    w.rackCapacity = 3;
    w.order(["rack", "placa-am1", "cpu-c1", "cooler", "ram-2", "ssd", "psu-300"]);
    w.deliver(true);
    for (const p of [...w.parts]) w.installPart(1, p.uid);
    for (const c of ["atx24", "cpu8", "sata", "red"] as const) w.connectCable(1, c);
    const b = w.powerOn(1).server!;
    const tb = w.shell(b.id);
    for (const x of ["srv-02", "ana", "otraClave123", "otraClave123"]) tb.input(x);
    sh(tb, "ip addr add 10.0.0.11/24 dev eth0");
    const t = w.shell(a.id);
    t.input("ssh ana@10.0.0.11");
    expect(t.input("mala").lines.at(-1)).toBe("Permission denied, please try again.");
    t.input("ssh ana@10.0.0.11");
    t.input("otraClave123");
    expect(t.prompt()).toBe("ana@srv-02:~$ ");
    sh(t, "exit");
    expect(t.prompt()).toBe("admin@srv-01:~$ ");
    expect(sh(t, "ssh 10.0.0.21")[0]).toContain("es un robot");
  });
});

describe("temperatura, GPU y núcleos", () => {
  test("un bucle sin wait() en 1 núcleo sin ventiladores calienta la CPU; el aire acondicionado la baja", () => {
    const run = (aire: boolean) => {
      const w = mundo();
      if (aire) w.services.add("aire");
      w.setScript("lupe", "while True:\n    pass\n");
      w.runRobot("lupe");
      for (let i = 0; i < 2000; i++) w.step();
      return w.server("srv-01")!.temp;
    };
    expect(run(false)).toBeGreaterThan(85);
    expect(run(true)).toBeLessThan(85);
  });

  test("con GPU, scan_item tarda la mitad", () => {
    const w = mundo();
    w.server("srv-01")!.gpu = true;
    expect(w.serverOf(w.robot("lupe"))!.gpu).toBe(true);
  });
});

describe("abrir un servidor para cambiarle piezas", () => {
  test("se apaga, se cambia la RAM y vuelve a encender con su Linux", () => {
    const w = mundo();
    w.startServerTutorial();
    const server = montar(w);
    server.os = { user: "admin", password: "clave-larga-123" };
    w.robot("tono").cpu.server = server.id;
    w.setScript("tono", "while True:\n    wait()\n");
    expect(w.openCase(server.id)).toEqual({ ok: true });
    expect(server.online).toBe(false);
    w.runRobot("tono");
    expect(w.isRunning("tono")).toBe(false); // abierto: no corre nada

    // la CPU no sale con el disipador encima; la placa no sale con piezas encima
    expect(w.removePart(0, "cpu")).toMatchObject({ ok: false });
    expect(w.removePart(0, "placa")).toMatchObject({ ok: false });
    expect(w.removePart(0, "ram", 0)).toEqual({ ok: true });
    expect(w.parts.map((p) => p.def)).toContain("ram-2");
    expect(w.powerOn(0).post.lines.at(-1)).toContain("memoria RAM");
    w.parts.push({ uid: 999, def: "ram-8" });
    expect(w.installPart(0, 999)).toEqual({ ok: true });
    // quitar el disco desconecta su cable
    expect(w.removePart(0, "ssd")).toEqual({ ok: true });
    expect(w.rackBuild(0).cables.has("sata")).toBe(false);
    const ssd = w.parts.find((p) => p.def === "ssd")!;
    w.installPart(0, ssd.uid);
    w.connectCable(0, "sata");

    const r = w.powerOn(0);
    expect(r.post.ok).toBe(true);
    expect(r.server).toBe(server);
    expect(w.servers).toHaveLength(1);
    expect(server).toMatchObject({ online: true, maintenance: false, ramGb: 8, os: { user: "admin" } });
    expect(w.racks[0]).toBeNull();
  });
});
