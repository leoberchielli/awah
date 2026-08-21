# site

A página de divulgação do AWAH, servida em **awah.99ia.com.br**.

*[English](README.md)*

Estático puro: um `index.html`, uma folha de estilo, dois arquivos de script e
as mídias. **Sem build, sem dependência, sem passo de instalação** — o que está
neste diretório é exatamente o que vai para o ar. Isso é deliberado: uma página
que precisa de `npm install` para receber a correção de uma vírgula não recebe a
correção.

```
site/
  index.html          conteúdo em português — é o que o buscador lê
  assets/styles.css   tokens de tema, componentes, responsivo
  assets/i18n.js      dicionário em inglês, aplicado por cima do HTML
  assets/main.js      gráficos em SVG, cópia, tema, revelação ao rolar
  assets/og.svg       fonte da imagem de compartilhamento
  assets/og.png       o que os agregadores de link leem (1200×630)
  assets/*-icon.png   favicons gerados do SVG (o iOS ignora SVG)
  assets/*.gif        as mesmas gravações de docs/img
  deploy/nginx.conf   o vhost na site01 — instalado à mão, uma vez
  robots.txt  sitemap.xml
```

`deploy/`, `og.html`, `make-og.mjs` e estes READMEs ficam de fora do envio: o
diretório é publicado inteiro, e uma configuração de servidor com porta interna
não tem por que virar URL.

## Ver localmente

```bash
python3 -m http.server 8000 --directory site
```

Depois abra `http://localhost:8000`. Abrir o `index.html` com `file://` também
funciona, menos a busca da contagem de estrelas — o navegador recusa a
requisição por origem.

## Publicar

O `.github/workflows/site.yml` publica na **site01** a cada push em `main` que
toque em `site/` — a mesma VM e o mesmo caminho por Cloudflare Access dos
outros subdomínios. Ele faz rsync para
`/home/deploy/awah-site/releases/<sha>` e só então move o symlink `current`,
porque copiar por cima do que está no ar serviria, por alguns segundos, o HTML
novo com o CSS velho. As cinco últimas releases ficam no disco, e é isso que
faz voltar atrás ser um `ln -sfn`.

Três coisas ficam fora do workflow, feitas uma vez à mão, porque um servidor
que se reconfigura a cada push é um servidor que ninguém revisa:

1. **O diretório**: `mkdir -p /home/deploy/awah-site/releases` como `deploy`.
2. **O vhost**: `deploy/nginx.conf` — escuta em `127.0.0.1:8091` e carrega os
   cabeçalhos de cache e segurança que a página assume.
3. **O túnel**: uma entrada de ingress apontando `awah.99ia.com.br` para
   `http://127.0.0.1:8091`, e `cloudflared tunnel route dns <túnel>
   awah.99ia.com.br` para criar o registro.

TLS e HTTP/2 ficam com o Cloudflare; dentro da VM é HTTP puro na loopback.

O diretório é estático puro, então qualquer outra hospedagem serve ele como
está — os cabeçalhos do `deploy/nginx.conf` são os que devem ser reproduzidos.

## Idiomas

O HTML é escrito em **português** — é o idioma do domínio, e é o que chega a
quem está sem JavaScript e ao robô de busca. O inglês vive em `assets/i18n.js`
e é aplicado por cima; o português original é guardado no primeiro passo, então
voltar para ele é restaurar, não retraduzir.

Ao mexer no texto de um elemento com `data-i18n`, mexa também na chave
correspondente em `i18n.js`. O par é verificável em um comando:

```bash
node -e "const f=require('fs'),h=f.readFileSync('site/index.html','utf8'),j=f.readFileSync('site/assets/i18n.js','utf8');
const k=new Set([...h.matchAll(/data-i18n=\"([^\"]+)\"/g)].map(m=>m[1]));
[...h.matchAll(/data-i18n-attr=\"([^\"]+)\"/g)].forEach(m=>m[1].split(',').forEach(p=>k.add(p.split(':')[1].trim())));
const e=new Set([...j.matchAll(/^\s*'?([a-z0-9._]+)'?\s*:/gmi)].map(m=>m[1]));
const falta=[...k].filter(x=>!e.has(x)); console.log(falta.length?'faltando: '+falta.join(', '):'ok: '+k.size+' chaves')"
```

O idioma inicial vem de `?lang=`, depois do que ficou salvo, depois do
navegador — e o padrão é português.

## As cores dos gráficos

Os dois tons de série (íris e ciano) não foram escolhidos por gosto. Eles
passam, contra as superfícies reais desta página, na banda de luminosidade, no
piso de croma, na separação para daltonismo (ΔE deutan e tritan) e no contraste
mínimo:

| | claro | escuro |
| --- | --- | --- |
| série 1 | `#4b4bc4` | `#7d7df0` |
| série 2 | `#0092a8` | `#22a6b8` |
| superfície | `#ffffff` | `#131720` |

Verde, âmbar e vermelho significam conectado, segurado e falho — como no painel
do produto — e nunca são usados por estilo. Trocar qualquer um desses valores
pede revalidar o conjunto.

Os dois gráficos trazem a tabela equivalente logo abaixo, aberta por um
`<details>`: cor não pode ser o único jeito de ler o dado.

## A imagem de compartilhamento

`assets/og.svg` é a fonte; `assets/og.png` é o que o Twitter, o LinkedIn e o
WhatsApp leem. Depois de editar o SVG:

```bash
node site/make-og.mjs      # precisa de sharp e das fontes IBM Plex instaladas
```

Sem o `sharp` à mão, `og.html` é a mesma imagem em HTML — abra em um navegador e
capture a janela em 1200×630. O mesmo PNG serve como *social preview* do
repositório no GitHub (Settings → General → Social preview).

## Notas

- **Não há `hreflang`** nem `?lang=en` no sitemap. O inglês é a mesma página
  trocada no navegador; anunciá-lo como URL alternativa enquanto a canônica
  dela aponta de volta para `/` é dizer duas coisas contrárias ao buscador. O
  inglês tem URL própria no README do repositório, que é onde ele deve estar.
- A `Content-Security-Policy` permite `'unsafe-inline'` em script por causa do
  bloco que aplica tema e idioma **antes da primeira pintura** — sem ele a
  página pisca no tema errado. Trocar por um hash é possível, e quebra a cada
  edição desse bloco.
- As fontes vêm do Google Fonts. Para servir da própria origem, baixe as duas
  famílias, aponte um `@font-face` local e tire `fonts.googleapis.com` e
  `fonts.gstatic.com` da CSP.
- Os GIFs são cópias de `docs/img/`. Se as gravações forem refeitas lá, copie de
  novo — não há link simbólico, de propósito: o diretório precisa continuar
  publicável sozinho.
