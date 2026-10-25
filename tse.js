/*
 * Leitura dos arquivos públicos de divulgação do TSE, direto do navegador.
 *
 * O TSE serve esses arquivos com CORS liberado, então o site não precisa de
 * servidor nem de proxy: o navegador de quem está vendo busca os dados na
 * fonte oficial. Por isso ele funciona hospedado em qualquer lugar estático,
 * inclusive GitHub Pages, e aguenta qualquer número de visitantes.
 *
 * São 27 arquivos de resultado (um por estado) + 27 de andamento por leitura.
 */

const BASE = "https://resultados.tse.jus.br/oficial";
const CICLO = "ele2026";

export const ELEICAO_1T = 6257;  // Federal 2026, 1º turno
export const ELEICAO_2T = 6258;  // Federal 2026, 2º turno
export const NUM_PL = "22";
export const NUM_PT = "13";

export const UFS = ["ac","al","am","ap","ba","ce","df","es","go","ma","mg","ms",
  "mt","pa","pb","pe","pi","pr","rj","rn","ro","rr","rs","sc","se","sp","to","zz"];

const cod = (n) => "e" + String(n).padStart(6, "0");

const urlResultado = (eleicao, uf) =>
  `${BASE}/${CICLO}/${eleicao}/dados/${uf}/${uf}-c0001-${cod(eleicao)}-u.json`;

const urlAndamento = (eleicao, uf) =>
  `${BASE}/${CICLO}/${eleicao}/dados/${uf}/${uf}-${cod(eleicao)}-ab.json`;

function num(txt) {
  if (txt === undefined || txt === null || txt === "") return 0;
  const s = String(txt);
  return s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
}

/* "19:32:07" -> segundos desde a meia-noite. */
function _segundos(hhmmss) {
  const m = String(hhmmss).match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

async function buscar(url) {
  // "no-cache" e não "no-store": os dois vão SEMPRE perguntar ao servidor, e
  // nenhum dos dois serve número velho. A diferença é o que acontece quando
  // o arquivo não mudou desde a última leitura — com "no-store" o TSE reenvia
  // o arquivo inteiro, com "no-cache" o navegador manda a etiqueta da versão
  // que já tem e recebe um "continua igual" de poucos bytes.
  //
  // Como a página pergunta a cada 25 segundos e o TSE republica mais devagar
  // que isso, a maior parte das leituras não traz novidade nenhuma. Pedir o
  // arquivo inteiro para descobrir isso é desperdício — de dados de quem
  // está olhando e de banda do TSE, multiplicado por todo mundo que estiver
  // acompanhando ao mesmo tempo.
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // A rede do TSE diz quantos segundos faltam para a cópia dela ser trocada
  // ("max-age"). É o relógio mais preciso que existe para saber quando vai
  // ter número novo: a página pergunta de novo logo depois disso.
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  if (m) {
    const quando = Date.now() + 1000 * (+m[1]);
    if (!(proximaTroca > Date.now()) || quando < proximaTroca) proximaTroca = quando;
  }
  return r.json();
}

let proximaTroca = 0;
/* Milissegundos até a próxima troca de arquivo na rede do TSE (0 = não sei). */
export function msAteNovidade() {
  const ms = proximaTroca - Date.now();
  return ms > 0 ? ms : 0;
}

/* Roda as tarefas com um teto de simultâneas, para não abrir 54 conexões de
 * uma vez e engasgar o navegador (e o celular de quem está vendo). */
async function emLotes(itens, trabalho, simultaneas = 16) {
  const saida = new Array(itens.length);
  let proximo = 0;
  const operarios = Array.from({ length: Math.min(simultaneas, itens.length) }, async () => {
    while (true) {
      const i = proximo++;
      if (i >= itens.length) break;
      saida[i] = await trabalho(itens[i]);
    }
  });
  await Promise.all(operarios);
  return saida;
}

export async function lerResultados(eleicao) {
  const observado = {};
  const nomes = {};
  const falhas = [];
  // Além dos votos dos dois finalistas, o arquivo traz brancos, nulos,
  // abstenção, comparecimento e seções — tudo o que o eleitor procura numa
  // noite de apuração, e que estava sendo ignorado.
  const totais = {
    brancos: 0, nulos: 0, abstencao: 0, comparecimento: 0,
    eleitorado: 0, secoes: 0, secoesApuradas: 0, validos: 0,
    porUf: {},   // uf -> [abstenção, comparecimento, brancos+nulos] do que já foi apurado
  };
  // Os 54 arquivos não são lidos no mesmo instante, e o TSE não publica todos
  // os estados ao mesmo tempo: o conjunto é um mosaico de momentos.
  //
  // Mostrar o carimbo MAIS RECENTE seria otimista — anunciaria como "dados de
  // 19h32" um conjunto em que algum estado ainda está em 19h28. O dado só é
  // tão novo quanto o mais ANTIGO dos arquivos, então é esse que vai para a
  // tela, e a dispersão entre o mais velho e o mais novo é devolvida para a
  // página poder avisar quando for grande.
  // (Apontado por uma auditoria externa do código.)
  let horaMaisNova = "";
  let horaMaisVelha = "";

  await emLotes(UFS, async (uf) => {
    try {
      const doc = await buscar(urlResultado(eleicao, uf));
      let pl = 0, pt = 0;
      for (const cargo of doc.carg || [])
        for (const agr of cargo.agr || [])
          for (const par of agr.par || [])
            for (const c of par.cand || []) {
              if (c.n === NUM_PL) { pl += num(c.vap); nomes.pl = (c.nmu || "").toLowerCase(); }
              else if (c.n === NUM_PT) { pt += num(c.vap); nomes.pt = (c.nmu || "").toLowerCase(); }
            }
      // Sanidade antes de aceitar. O TSE não manda número negativo nem voto
      // a mais do que existe eleitor — mas a página não fala só com o TSE:
      // fala com a rede inteira entre ele e o aparelho de quem está olhando.
      // Um proxy de operadora, um cache intermediário ou um wifi de shopping
      // com "portal de login" podem devolver corpo trocado ou corrompido.
      //
      // Sem esta conferência, votos negativos e votos gigantes passavam
      // direto e viravam um placar de aparência perfeitamente normal — um
      // 50% × 50% inventado é muito pior do que tela vazia. Descoberto em
      // programa/testar_resiliencia.mjs.
      //
      // O teto é o maior eleitorado estadual (São Paulo, cerca de 35
      // milhões) com folga larga: qualquer UF acima disso é corrupção, não
      // apuração.
      const TETO_UF = 40e6;
      if (!(pl >= 0 && pt >= 0 && isFinite(pl) && isFinite(pt)
            && pl + pt <= TETO_UF)) {
        throw new Error("votos fora de qualquer faixa plausível em " + uf);
      }
      observado[uf] = { pl, pt };

      const v = doc.v || {}, e = doc.e || {}, s = doc.s || {};
      totais.brancos += num(v.vb);
      totais.nulos += num(v.tvn);
      totais.validos += num(v.vv);
      totais.abstencao += num(e.a);
      totais.comparecimento += num(e.c);
      totais.eleitorado += num(e.te);
      totais.secoes += num(s.ts);
      totais.secoesApuradas += num(s.st);
      totais.porUf[uf] = [num(e.a), num(e.c), num(v.vb) + num(v.tvn)];
      // Horário em que o TSE gerou o arquivo — mais fiel que a hora local
      // de quem está olhando.
      if (doc.ht) {
        if (!horaMaisNova || doc.ht > horaMaisNova) horaMaisNova = doc.ht;
        if (!horaMaisVelha || doc.ht < horaMaisVelha) horaMaisVelha = doc.ht;
      }
    } catch (err) {
      falhas.push(uf);
    }
  });

  // Segundos entre o arquivo mais velho e o mais novo do conjunto.
  const dispersao = (horaMaisVelha && horaMaisNova)
    ? Math.max(0, _segundos(horaMaisNova) - _segundos(horaMaisVelha)) : 0;

  return { observado, nomes, falhas, totais,
           horaTSE: horaMaisVelha || horaMaisNova, dispersao };
}

/* Resultado oficial de UM município, buscado quando a pessoa toca nele no
 * mapa. É um arquivo pequeno (poucos KB), lido uma vez por toque — nunca em
 * laço —, então não pesa nem para quem olha nem para o TSE. */
export async function lerMunicipio(eleicao, uf, cd) {
  const url = `${BASE}/${CICLO}/${eleicao}/dados/${uf}/${uf}${cd}-c0001-${cod(eleicao)}-u.json`;
  const doc = await buscar(url);
  let pl = 0, pt = 0;
  for (const cargo of doc.carg || [])
    for (const agr of cargo.agr || [])
      for (const par of agr.par || [])
        for (const c of par.cand || []) {
          if (c.n === NUM_PL) pl += num(c.vap);
          else if (c.n === NUM_PT) pt += num(c.vap);
        }
  const s = doc.s || {};
  return { pl, pt, pctSecoes: num(s.pst), hora: doc.ht || "" };
}

/* Andamento de uma UF inteira, cidade a cidade — usado para o exterior, em
 * que cada "município" é uma cidade com seção eleitoral fora do Brasil. */
export async function lerAndamentoUF(eleicao, uf) {
  const doc = await buscar(urlAndamento(eleicao, uf));
  return (doc.abr || []).filter((a) => a.tpabr === "mun").map((a) => ({
    cd: a.cdabr,
    te: num(a.e && a.e.te),          // eleitores aptos
    est: num(a.e && a.e.est),        // eleitores das seções já totalizadas
    ts: num(a.s && a.s.ts),          // seções
    st: num(a.s && a.s.st),          // seções totalizadas
    fim: a.and === "f",
  }));
}

export async function lerAndamento(eleicao) {
  const fracoes = new Map();
  const falhas = [];

  await emLotes(UFS, async (uf) => {
    try {
      const doc = await buscar(urlAndamento(eleicao, uf));
      for (const abr of doc.abr || []) {
        if (abr.tpabr !== "mun") continue;
        const e = abr.e || {};
        const total = num(e.te);
        const apurado = num(e.est);
        fracoes.set(`${uf}/${abr.cdabr}`, total > 0 ? apurado / total : 0);
      }
    } catch (e) {
      falhas.push(uf);
    }
  });

  return { fracoes, falhas };
}

export async function lerTudo(eleicao) {
  const [res, and] = await Promise.all([lerResultados(eleicao), lerAndamento(eleicao)]);

  // Os votos de uma UF e o andamento dela vêm de arquivos diferentes, e um
  // pode chegar sem o outro. Esse descasamento é grave, e silencioso:
  //
  // Se os votos de São Paulo chegam e o andamento de São Paulo falha, o
  // modelo recebe 22 milhões de votos observados E não sabe que nenhuma
  // parte do estado foi apurada — então soma esses votos ao total e, em
  // cima disso, projeta São Paulo inteiro como se ainda estivesse zerado.
  // Os mesmos votos entram duas vezes. Medido: desloca a projeção nacional
  // em 1,12 ponto percentual, sem nenhum aviso na tela.
  //
  // O inverso — andamento sem votos — faz o modelo tratar como "ainda não
  // apurado" uma parte que já foi, e também distorce.
  //
  // Então uma UF só entra no cálculo quando os DOIS arquivos dela chegaram.
  // Faltando um, ela é tratada como falha: sai da conta e aparece no aviso
  // de estados sem resposta. Projeção com dado pela metade é pior que
  // projeção sem aquele estado.
  // (Apontado por uma auditoria externa do código.)
  const ufsComVotos = new Set(Object.keys(res.observado));
  const ufsComAndamento = new Set();
  for (const chave of and.fracoes.keys()) {
    ufsComAndamento.add(chave.split("/")[0]);
  }

  const incompletas = [];
  const observado = {};
  for (const uf of ufsComVotos) {
    if (ufsComAndamento.has(uf)) observado[uf] = res.observado[uf];
    else incompletas.push(uf);
  }

  const fracoes = new Map();
  for (const [chave, v] of and.fracoes) {
    const uf = chave.split("/")[0];
    if (ufsComVotos.has(uf)) fracoes.set(chave, v);
    else if (!incompletas.includes(uf)) incompletas.push(uf);
  }

  return {
    observado,
    fracoes,
    nomes: res.nomes,
    totais: res.totais,
    horaTSE: res.horaTSE,
    dispersao: res.dispersao,
    falhas: [...new Set([...res.falhas, ...and.falhas, ...incompletas])],
  };
}
