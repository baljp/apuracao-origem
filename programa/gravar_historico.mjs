/*
 * Grava a evolução da apuração ao longo da noite, num arquivo público.
 *
 * O site guarda a trajetória no aparelho de quem está olhando, mas quem chega
 * às 20h não tem o que aconteceu antes. Este programa roda no GitHub Actions
 * (.github/workflows/historico.yml) durante a apuração: a cada minuto lê o
 * TSE, roda o MESMO modelo do site (modelo.js) e, quando a apuração andou,
 * acrescenta um ponto em historico.json — nacional, por estado e por região.
 * O arquivo vai para o ramo "historico" do repositório (não para o site, para
 * não disparar uma publicação do site a cada minuto), e o site o lê de lá.
 *
 * Uso:  node programa/gravar_historico.mjs historico.json [minutos]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { Modelo, REGIAO } from "../modelo.js";
import * as tse from "../tse.js";

const ARQ = process.argv[2] || "historico.json";
const MINUTOS = parseFloat(process.argv[3] || "350");
const EMPURRAR = process.env.EMPURRAR === "1";
const RAMO = process.env.RAMO || "historico";
const ELEICAO = parseInt(process.env.ELEICAO || String(tse.ELEICAO_2T), 10);  // teste: ELEICAO=6257
const base = JSON.parse(readFileSync(new URL("../base.json", import.meta.url)));
const modelo = new Modelo(base);
const NOMES = { "norte": "Norte", "nordeste": "Nordeste", "centro-oeste": "Centro-Oeste",
  "sudeste": "Sudeste", "sul": "Sul" };

let hist = { eleicao: ELEICAO, pontos: [] };
if (existsSync(ARQ)) { try { hist = JSON.parse(readFileSync(ARQ)); } catch {} }

const r2 = (v) => v == null ? null : Math.round(v * 100) / 100;
const fim = Date.now() + MINUTOS * 60000;
let ultimoEmpurrao = 0, mudou = false, completoDesde = 0;

function regioes(r) {
  const acc = new Map();
  for (const e of r.estados) {
    if (e.regiao === "exterior") continue;
    const a = acc.get(e.regiao) || { pl: 0, pt: 0, apu: 0, peso: 0 };
    a.pl += e.vPl || 0; a.pt += e.vPt || 0;
    const peso = (e.vPl || 0) + (e.vPt || 0);
    a.apu += e.pctApurado * peso; a.peso += peso;
    acc.set(e.regiao, a);
  }
  return ["nordeste", "sudeste", "sul", "norte", "centro-oeste"].filter((k) => acc.has(k)).map((k) => {
    const a = acc.get(k), v = a.pl + a.pt;
    return [NOMES[k], r2(a.peso ? a.apu / a.peso : 0), r2(v ? 100 * a.pl / v : 50)];
  });
}

async function rodada() {
  const d = await tse.lerTudo(ELEICAO);
  let vp = 0, vt = 0;
  for (const o of Object.values(d.observado || {})) { vp += o.pl; vt += o.pt; }
  if (!(vp + vt > 0)) return;
  const r = modelo.projetar(d.fracoes, d.observado, 240);
  if (!(r.pctApurado > 0.05)) return;
  const ult = hist.pontos[hist.pontos.length - 1];
  const agora = Date.now();
  // Um ponto a cada 0,25 ponto de apuração, ou a cada 5 minutos parado.
  if (ult && r.pctApurado < ult.a + 0.25 && agora - ult.t * 1000 < 300000) return;
  const u = {};
  for (const e of r.estados) if (e.obsPl != null) u[e.uf] = [r2(e.pctApurado), r2(e.obsPl), r2(e.projPl)];
  hist.pontos.push({
    t: Math.round(agora / 1000), h: d.horaTSE || "",
    a: r2(r.pctApurado), o: r2(r.brutoPl), p: r2(r.projecaoPl),
    lo: r2(r.faixaPl[0]), hi: r2(r.faixaPl[1]), ch: Math.round(r.probPl * 1000) / 1000,
    vp: Math.round(vp), vt: Math.round(vt), reg: regioes(r), u,
  });
  hist.atualizado = new Date(agora).toISOString();
  writeFileSync(ARQ, JSON.stringify(hist));
  mudou = true;
  console.log(new Date().toISOString(), "apurado", r.pctApurado.toFixed(2), "projeção", r.projecaoPl.toFixed(2));
  if (r.pctApurado >= 99.99 && !completoDesde) completoDesde = agora;
}

function empurrar() {
  if (!EMPURRAR || !mudou) return;
  try {
    execSync(`git add ${ARQ} && git -c user.name="apuracao-bot" -c user.email="apuracao-bot@users.noreply.github.com" commit -q -m "historico: ${hist.pontos.length} pontos" && git push -q origin HEAD:${RAMO}`, { stdio: "inherit" });
    mudou = false;
  } catch (e) { console.log("push falhou:", e.message); }
}

while (Date.now() < fim) {
  try { await rodada(); } catch (e) { console.log("TSE:", e.message); }
  if (Date.now() - ultimoEmpurrao > 90000) { empurrar(); ultimoEmpurrao = Date.now(); }
  // Apuração encerrada há meia hora: grava o último e termina.
  if (completoDesde && Date.now() - completoDesde > 30 * 60000) break;
  await new Promise((res) => setTimeout(res, 60000));
}
empurrar();
