/*
 * A noite inteira, de ponta a ponta, numa sessão só.
 *
 * Os outros testes olham pedaços: o modelo em Python, a resiliência a
 * falhas, a carga. Este percorre a noite como uma pessoa percorreria —
 * mesma aba aberta, apuração avançando — e confere a cada parada se a tela
 * continua coerente consigo mesma.
 *
 * O que ele persegue não é "funciona", é contradição interna: projeção fora
 * da própria margem, estado sumindo da lista, probabilidade que diz uma
 * coisa enquanto o número diz outra, trajetória que não acumula, soma que
 * não fecha. Esse tipo de defeito não quebra a página — ela segue bonita,
 * mostrando um número errado, que é o pior jeito de falhar numa noite de
 * apuração.
 *
 * Uso:  node programa/testar_e2e.mjs [url]
 */

import puppeteer from "puppeteer-core";

const CHROME = "/root/.cache/puppeteer/chrome/linux-131.0.6778.204/"
  + "chrome-linux64/chrome";
const SITE = process.argv[2] || "http://localhost:8899/";

// Os pontos da noite onde vale parar e conferir. Os primeiros são os que
// importam: é para 1%–5% que este projeto existe.
const PARADAS = [0.5, 1, 2, 3, 5, 10, 20, 35, 50, 75, 100];

const n = (txt) => {
  const v = parseFloat(String(txt).replace("%", "").replace(",", ".").trim());
  return isFinite(v) ? v : null;
};

const nav = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const p = await nav.newPage();
const errosJS = [];
p.on("pageerror", (e) => errosJS.push(e.message.slice(0, 80)));
p.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !/frame-ancestors|wikipedia|429|ERR_FAILED/.test(t)) {
    errosJS.push("console: " + t.slice(0, 80));
  }
});
await p.setViewport({ width: 390, height: 1400 });

console.log(`\nA noite inteira — ${SITE}\n${"=".repeat(74)}`);
console.log("apurado   projeção      margem          prob.  estados  mapa  trajet.");
console.log("-".repeat(74));

const problemas = [];
let anterior = null;
let trajetoriaAntes = 0;

for (const marco of PARADAS) {
  await p.goto(`${SITE}?demo=${marco}`, { waitUntil: "networkidle2", timeout: 60000 });
  // O mapa só é montado quando chega perto da tela: rola até ele.
  await p.evaluate(() => document.getElementById("cartaoMapa").scrollIntoView());
  await new Promise((r) => setTimeout(r, 4500));

  const d = await p.evaluate(() => {
    const t = (id) => (document.getElementById(id) || {}).textContent || "";
    const faixa = t("faixaPL").match(/([\d,]+)%\s*e\s*([\d,]+)%/);
    // A chave carrega o turno e a data (trajetoria-6258-2026-10-25), então
    // é procurada por prefixo e não por nome fixo.
    let traj = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("trajetoria-")) {
          const h = JSON.parse(localStorage.getItem(k) || "[]");
          if (Array.isArray(h)) traj = Math.max(traj, h.length);
        }
      }
    } catch { /* modo privado: o site funciona sem isso */ }
    return {
      apurado: t("apurado"), pl: t("pctPL"), pt: t("pctPT"),
      faixaLo: faixa ? faixa[1] : null, faixaHi: faixa ? faixa[2] : null,
      prob: t("probabilidade"),
      estados: document.querySelectorAll(".uf-linha").length,
      mapa: document.querySelectorAll("#mapa path.m").length,
      placarVisivel: getComputedStyle(document.getElementById("placar")).display !== "none",
      traj,
      chaves: Object.keys(localStorage),
    };
  });

  const apurado = n(d.apurado), pl = n(d.pl), pt = n(d.pt);
  const lo = n(d.faixaLo), hi = n(d.faixaHi);
  const ruim = [];

  // 1. Os dois percentuais têm de somar 100: são votos válidos, não há terceiro.
  if (pl !== null && pt !== null && Math.abs(pl + pt - 100) > 0.15) {
    ruim.push(`soma ${(pl + pt).toFixed(1)} ≠ 100`);
  }
  // 2. A projeção tem de caber na própria margem. Se não couber, uma das
  //    duas está errada, e não dá para saber qual — por isso é grave.
  if (pl !== null && lo !== null && hi !== null && (pl < lo - 0.05 || pl > hi + 0.05)) {
    ruim.push(`projeção ${pl} fora da margem ${lo}–${hi}`);
  }
  if (lo !== null && hi !== null && hi < lo) ruim.push("margem invertida");
  // 3. A margem tem de encolher conforme apura. Se alargar muito, o modelo
  //    está ficando menos certo com MAIS informação.
  if (anterior && lo !== null && anterior.larg !== null) {
    const larg = hi - lo;
    if (larg > anterior.larg + 1.2) {
      ruim.push(`margem alargou de ${anterior.larg.toFixed(1)} para ${larg.toFixed(1)}`);
    }
  }
  // 4. O apurado tem de andar para frente e parar em 100.
  if (apurado === null || apurado < 0 || apurado > 100.05) ruim.push(`apurado ${d.apurado}`);
  if (anterior && apurado !== null && apurado < anterior.apurado - 0.5) {
    ruim.push(`apurado andou para trás (${anterior.apurado} → ${apurado})`);
  }
  // 5. A probabilidade tem de apontar para quem está na frente.
  const dizPl = /Flavio|Flávio/i.test(d.prob), dizPt = /Lula/i.test(d.prob);
  if (pl !== null && apurado > 1) {
    if (pl > 50.5 && dizPt && !dizPl) ruim.push("probabilidade aponta o candidato errado");
    if (pl < 49.5 && dizPl && !dizPt) ruim.push("probabilidade aponta o candidato errado");
  }
  // 6. Nada pode sumir da tela no meio da noite.
  // O mapa agora é por município (5,5 mil), e a lista de estados mostra 10
  // de cara, com um botão para os demais.
  if (d.mapa < 5500) ruim.push(`mapa com ${d.mapa} municípios`);
  if (apurado > 1 && d.estados < 10) ruim.push(`lista com ${d.estados} estados`);
  if (apurado > 1 && !d.placarVisivel) ruim.push("placar sumiu");

  problemas.push(...ruim.map((x) => `${marco}%: ${x}`));
  console.log(
    `${String(marco).padStart(5)}%  ${d.pl.padStart(7)}  ${String(lo).padStart(5)}–${String(hi).padEnd(5)}`
    + `  ${(d.prob.match(/[\d,]+%/) || ["—"])[0].padStart(6)}`
    + `  ${String(d.estados).padStart(5)}  ${String(d.mapa).padStart(4)}`
    + `  ${String(d.traj).padStart(5)}`
    + (ruim.length ? "  ✗ " + ruim.join("; ") : ""));

  anterior = { apurado, larg: (lo !== null && hi !== null) ? hi - lo : null };
  trajetoriaAntes = d.traj;
}

// 7. A trajetória tem de sobreviver a recarregar a página: é o que permite
//    desenhar o gráfico de como a projeção se moveu durante a noite.
await p.goto(`${SITE}?demo=50`, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
const depois = await p.evaluate(() => {
  try {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("trajetoria-")) {
        n = Math.max(n, JSON.parse(localStorage.getItem(k) || "[]").length);
      }
    }
    return n;
  } catch { return -1; }
});
console.log("-".repeat(74));
console.log(`trajetória guardada no aparelho: ${depois} ponto(s)`);
if (depois === 0) problemas.push("a trajetória não está sendo guardada — o gráfico"
  + " da noite não teria o que mostrar depois de uma recarga");

console.log(`erros de JS durante toda a noite: ${errosJS.length || "nenhum"}`);
errosJS.slice(0, 4).forEach((e) => console.log("  ✗ " + e));
if (errosJS.length) problemas.push(`${errosJS.length} erro(s) de JS`);

await nav.close();
console.log(`\n${"=".repeat(74)}`);
if (problemas.length) {
  problemas.forEach((x) => console.log("✗ " + x));
  process.exit(1);
}
console.log("a noite inteira sem contradição");
