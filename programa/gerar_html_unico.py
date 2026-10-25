"""
Gera o `apuracao.html`: um arquivo único, sem nenhuma dependência externa.

Pega o site inteiro — página, modelo, leitura do TSE e a base dos 5.716
municípios — e costura tudo dentro de um HTML só. O arquivo pode ser salvo no
celular, mandado por WhatsApp ou guardado num pendrive: abre direto, sem
servidor e sem internet para carregar (só precisa de rede para buscar os dados
do TSE, que é o ponto).

Isso funciona porque o TSE libera CORS inclusive para origem nula, que é o caso
de um arquivo aberto do próprio aparelho.

Uso:  python3 gerar_html_unico.py
"""

from __future__ import annotations

import json
import os
import re
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
SAIDA = os.path.join(RAIZ, "apuracao.html")


def ler(nome: str) -> str:
    with open(os.path.join(RAIZ, nome), encoding="utf-8") as fh:
        return fh.read()


def tirar_exports(js: str) -> str:
    """Transforma um módulo ES em código solto, para caber num <script> só."""
    js = re.sub(r"^\s*import\s+.*?;\s*$", "", js, flags=re.MULTILINE | re.DOTALL)
    js = re.sub(r"^export\s+", "", js, flags=re.MULTILINE)
    return js


def main() -> int:
    for nome in ("index.html", "modelo.js", "tse.js", "pesquisas.js",
                 "base.json", "mapa.json", "ordem.json", "mapa-mun.json",
                 "fonte.css"):
        if not os.path.exists(os.path.join(RAIZ, nome)):
            print("Falta %s — rode antes gerar_base_site.py" % nome)
            return 1

    html = ler("index.html")
    html_original = html
    modelo = tirar_exports(ler("modelo.js"))
    tsejs = tirar_exports(ler("tse.js"))
    pesquisasjs = tirar_exports(ler("pesquisas.js"))
    base = json.loads(ler("base.json"))
    mapa = json.loads(ler("mapa.json"))
    ordem = json.loads(ler("ordem.json"))
    mapa_mun = json.loads(ler("mapa-mun.json"))

    # Os módulos expõem suas funções com nomes curtos; dentro do arquivo único
    # elas viram globais, então o código da página passa a chamá-las por
    # objetos (`tse`, `pq`) montados aqui, com os mesmos nomes dos imports.
    #
    # Esquecer um módulo aqui não quebra na geração: quebra no celular de quem
    # abriu o arquivo, com "pq is not defined" e a aba de pesquisas vazia. Por
    # isso a conferência no fim desta função é obrigatória.
    ponte = """
const tse = { lerTudo, lerResultados, lerAndamento, lerMunicipio, lerAndamentoUF, ELEICAO_1T,
              ELEICAO_2T, UFS };
const pq = { buscarSegundoTurno, buscarPrimeiroTurno, agregar, cruzarComTSE,
             REAL_1T };
const BASE_EMBUTIDA = __BASE__;
const MAPA_EMBUTIDO = __MAPA__;
const ORDEM_EMBUTIDA = __ORDEM__;
const MAPA_MUN_EMBUTIDO = __MAPAMUN__;
"""

    script_pagina = re.search(
        r'<script type="module">(.*?)</script>', html, re.DOTALL
    )
    if not script_pagina:
        print("Não encontrei o script da página no index.html")
        return 1
    corpo = script_pagina.group(1)

    # Sem imports (já estão embutidos) e lendo a base de dentro do arquivo.
    corpo = re.sub(r'^\s*import\s+.*?;\s*$', "", corpo, flags=re.MULTILINE | re.DOTALL)
    trocas = [
        ('const base = await (await fetch("./base.json", { cache: "force-cache" })).json();',
         "const base = await Promise.resolve(BASE_EMBUTIDA);"),
        ('geoMapa = await (await fetch("./mapa.json", { cache: "force-cache" })).json();',
         "geoMapa = await Promise.resolve(MAPA_EMBUTIDO);"),
        ('geoMun = await (await fetch("./mapa-mun.json", { cache: "force-cache" })).json();',
         "geoMun = await Promise.resolve(MAPA_MUN_EMBUTIDO);"),
        ('const [ordem, base] = await Promise.all([\n'
         '        fetch("./ordem.json", { cache: "force-cache" }).then((r) => r.json()),\n'
         '        fetch("./base.json", { cache: "force-cache" }).then((r) => r.json()),\n'
         '      ]);',
         "const [ordem, base] = await Promise.resolve(\n        [ORDEM_EMBUTIDA, BASE_EMBUTIDA]);"),
    ]
    # O `await` é mantido de propósito em cada troca. Sem ele o arranque da
    # página deixa de pausar no ponto em que pausava com `fetch`, passa a
    # correr direto e toca em variáveis `let` que ainda não foram declaradas —
    # "Cannot access 'pesquisas' before initialization", só no arquivo único.
    for alvo, novo in trocas:
        if alvo not in corpo:
            print("Não achei no index.html o trecho a substituir:\n  %s" % alvo)
            return 1
        corpo = corpo.replace(alvo, novo)
    # Service worker e manifest não existem num arquivo solto.
    corpo = re.sub(
        r'if \("serviceWorker" in navigator.*?\n}\n', "", corpo, flags=re.DOTALL
    )

    embutido = ponte.replace(
        "__BASE__", json.dumps(base, ensure_ascii=False, separators=(",", ":"))
    ).replace(
        "__MAPA__", json.dumps(mapa, ensure_ascii=False, separators=(",", ":"))
    ).replace(
        "__ORDEM__", json.dumps(ordem, ensure_ascii=False, separators=(",", ":"))
    ).replace(
        "__MAPAMUN__", json.dumps(mapa_mun, ensure_ascii=False, separators=(",", ":"))
    )
    novo_script = (
        "<script>\n"
        + modelo + "\n"
        + tsejs + "\n"
        + pesquisasjs + "\n"
        + embutido
        + "\n" + corpo + "\n</script>"
    )
    html = html[:script_pagina.start()] + novo_script + html[script_pagina.end():]

    # A fonte vai embutida no próprio arquivo.
    # (e os pré-carregamentos de arquivos que não existem no HTML solto saem)
    html, n = re.subn(r'<link rel="preload" href="\./fonte\.css"[^>]*>\n<noscript>.*?</noscript>',
                      lambda m: "<style>\n" + ler("fonte.css") + "</style>", html, flags=re.S)
    if not n:
        print("Não achei o link da fonte no index.html")
        return 1
    html = re.sub(r'<link rel="(?:modulepreload|preload)" href="\./[^"]+"[^>]*>\n?', "", html)

    # Referências a arquivos que não acompanham o HTML solto.
    html = re.sub(r'<link rel="manifest"[^>]*>\n?', "", html)
    html = re.sub(r'<link rel="icon"[^>]*>\n?', "", html)
    html = re.sub(r'<link rel="apple-touch-icon"[^>]*>\n?', "", html)

    # Os cartões de instalação só fazem sentido no site.
    html = html.replace('<div class="cartao instalar" id="cartaoInstalar">',
                        '<div class="cartao instalar" id="cartaoInstalar" hidden>')
    html = html.replace('<div class="cartao instalar" id="cartaoIOS">',
                        '<div class="cartao instalar" id="cartaoIOS" hidden>')

    # Conferência antes de gravar.
    #
    # Isto existe porque o arquivo único já saiu quebrado sem ninguém notar: o
    # index.html ganhou `import * as pq from "./pesquisas.js"`, o gerador não
    # embutia esse módulo, e o resultado abria normalmente — só que a aba de
    # pesquisas dizia "pq is not defined" no celular de quem baixou. O gerador
    # não acusou nada, porque gerar deu certo. O que falhou foi o que ele
    # deixou de fazer.
    problemas = []

    # Todo apelido de import do index.html precisa existir como variável aqui.
    for apelido in re.findall(r'import\s+\*\s+as\s+(\w+)\s+from', html_original):
        if not re.search(r'\b(?:const|let|var)\s+%s\s*=' % apelido, novo_script):
            problemas.append("o módulo importado como `%s` não foi embutido"
                             % apelido)
    for chaves in re.findall(r'import\s*\{([^}]+)\}\s*from', html_original):
        for nome in (c.strip().split()[0] for c in chaves.split(",") if c.strip()):
            if not re.search(r'\b(?:function|class|const|let|var)\s+%s\b' % nome,
                             novo_script):
                problemas.append("`%s` foi importado e não está embutido" % nome)

    # Nenhum arquivo local pode sobrar para ser buscado em tempo de execução:
    # o HTML solto não tem pasta ao lado dele.
    for alvo in re.findall(r'fetch\(\s*"\./([^"]+)"', novo_script):
        if not alvo.startswith("registro-tse"):   # opcional, e já tratado
            problemas.append("ainda busca o arquivo local ./%s" % alvo)

    if problemas:
        print("O arquivo único sairia quebrado:")
        for p in problemas:
            print("  - %s" % p)
        return 1

    with open(SAIDA, "w", encoding="utf-8") as fh:
        fh.write(html)

    tam = os.path.getsize(SAIDA)
    print("Arquivo único gerado: %s" % SAIDA)
    print("  tamanho: %.0f KB" % (tam / 1024))
    print("  %d municípios embutidos" % len(base["ufs"]))
    print("\n  Pode ser aberto direto do celular, mandado por WhatsApp ou")
    print("  guardado num pendrive. Não precisa de servidor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
