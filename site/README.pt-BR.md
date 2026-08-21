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
  assets/*.gif        as mesmas gravações de docs/img
  netlify.toml
  _headers            cabeçalhos para Netlify e Cloudflare Pages
  robots.txt  sitemap.xml  CNAME
```

## Ver localmente

```bash
python3 -m http.server 8000 --directory site
```

Depois abra `http://localhost:8000`. Abrir o `index.html` com `file://` também
funciona, menos a busca da contagem de estrelas — o navegador recusa a
requisição por origem.

## Publicar

Qualquer hospedagem de arquivo estático serve. O diretório inteiro é a raiz do
site; não há nada para compilar.

| Onde | Como |
| --- | --- |
| **Netlify** | Conecte o repositório, diretório de publicação `site`, comando de build vazio. O `netlify.toml` já traz cabeçalhos e cache. |
| **Cloudflare Pages** | Igual: sem comando de build, diretório de saída `site`. Lê o `_headers`. |
| **GitHub Pages** | O workflow `.github/workflows/site.yml` publica a cada push em `main` que toque em `site/`. O `CNAME` já aponta para o domínio. |
| **nginx** | `root /caminho/para/site;` e um `try_files $uri $uri/ /index.html;`. |

No DNS, um `CNAME` de `awah` para o host escolhido. TLS fica com a hospedagem.

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
