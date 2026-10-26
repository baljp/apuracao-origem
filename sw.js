/*
 * Service worker — é o que permite instalar a página como aplicativo no
 * celular e abrir rápido mesmo com internet ruim.
 *
 * A regra importante aqui é a separação entre duas coisas:
 *
 *   o casco (HTML, scripts, base do 1º turno, ícones) nunca muda durante a
 *   noite, então fica guardado no aparelho e abre instantaneamente;
 *
 *   os dados do TSE NUNCA são guardados. Toda leitura vai direto à rede. Um
 *   aplicativo de apuração que mostra número velho em cache seria pior do que
 *   não existir.
 */

const VERSAO = "apuracao-f048d83142";

// Só estes dois destinos externos são buscados pela página. Qualquer outro é
// recusado aqui, de modo que nem um script injetado conseguiria usar o
// service worker para falar com outro servidor.
const PERMITIDOS = ["resultados.tse.jus.br", "pt.wikipedia.org"];

const CASCO = [
  "./",
  "./index.html",
  "./modelo.js",
  "./tse.js",
  "./pesquisas.js",
  "./base.json",
  "./mapa.json",
  "./mapa-mun.json",
  "./fonte.css",
  "./ordem.json",
  "./manifest.webmanifest",
  "./icone-192.png",
  "./icone-512.png",
  "./icone-maskable.png",
  "./favicon.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(VERSAO)
      // cache: "reload" pula o cache HTTP do navegador (10 min no GitHub
      // Pages): a versão nova guarda os arquivos novos, não os de antes.
      .then((cache) => cache.addAll(CASCO.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())  // falta de um arquivo não trava a instalação
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      // VERSAO é o hash do conteúdo do site, carimbado por
      // programa/versionar.py. Quando qualquer arquivo muda, o nome do cache
      // muda junto, e todos os caches anteriores são apagados aqui. É assim
      // que o aparelho se limpa sozinho a cada publicação.
      .then((chaves) => Promise.all(
        chaves.filter((c) => c !== VERSAO).map((c) => caches.delete(c))
      ))
      .then(() => self.clients.claim())
      .then(async () => {
        // Avisa as abas abertas que há versão nova, para que se recarreguem
        // sem a pessoa precisar fazer nada.
        const abas = await self.clients.matchAll({ type: "window" });
        for (const aba of abas) aba.postMessage({ tipo: "versao-nova", VERSAO });
      })
  );
});

self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Dados ao vivo (TSE, Wikipédia): sempre da rede, nunca do cache.
  if (PERMITIDOS.some((h) => url.hostname === h)) return;

  // Qualquer outro destino externo não é coisa desta página: deixa passar
  // sem tocar, para o navegador aplicar a política de segurança normalmente.
  if (url.origin !== self.location.origin) return;

  // A página em si vai PRIMEIRO à rede, com o cache como rede de segurança.
  // Se fosse o contrário, uma correção publicada só apareceria na segunda
  // vez que a pessoa abrisse o app — que foi exatamente o que aconteceu
  // quando a aba de pesquisas entrou no ar.
  const ehPagina = req.mode === "navigate" ||
    (req.destination === "" && url.pathname.endsWith(".html")) ||
    url.pathname === "/" || url.pathname.endsWith("/");

  if (ehPagina) {
    evento.respondWith(
      // cache: "reload" ignora o cache HTTP do navegador e vai mesmo à rede.
      // Sem isso, o cache de 10 minutos do GitHub Pages seguraria a página
      // antiga aqui dentro, e uma correção publicada no meio da apuração
      // demoraria a chegar.
      fetch(req, { cache: "reload" }).then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(VERSAO).then((cache) => cache.put(req, copia));
        }
        return resp;
      }).catch(() => caches.match(req).then((g) => g || caches.match("./index.html")))
    );
    return;
  }

  // Scripts, base e ícones: do cache na hora, atualizando em segundo plano.
  evento.respondWith(
    caches.match(req).then((guardado) => {
      const daRede = fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(VERSAO).then((cache) => cache.put(req, copia));
        }
        return resp;
      }).catch(() => guardado);
      return guardado || daRede;
    })
  );
});
