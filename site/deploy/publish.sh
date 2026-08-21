#!/usr/bin/env bash
#
# Publica a página no host, no mesmo desenho do deploy da VM: a release vai
# para um diretório próprio e só então o symlink `current` muda. Copiar por
# cima do que está no ar serviria, por alguns segundos, o HTML novo com o CSS
# velho.
#
#   ./site/deploy/publish.sh            # publica o estado atual de site/
#   ./site/deploy/publish.sh --rollback # volta para a release anterior
#
# Não reinicia nada: o servidor resolve o symlink a cada requisição.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${AWAH_SITE_BASE:-$HOME/awah-site}"
RELEASES="$BASE/releases"

mkdir -p "$RELEASES"

if [ "${1:-}" = "--rollback" ]; then
  anterior=$(ls -1dt "$RELEASES"/*/ | sed -n 2p || true)
  [ -n "$anterior" ] || { echo "não há release anterior para voltar"; exit 1; }
  ln -sfn "${anterior%/}" "$BASE/current.tmp"
  mv -T "$BASE/current.tmp" "$BASE/current"
  echo "voltou para $(basename "${anterior%/}")"
  exit 0
fi

# O nome da release é o commit quando há um; fora de um repositório limpo, a
# data serve — o que importa é a ordem e poder voltar.
sha=$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
sujo=$(git -C "$REPO" status --porcelain site/ 2>/dev/null || true)
[ -n "$sujo" ] && sha="$sha-sujo"

REL="$RELEASES/$sha"
rm -rf "$REL"
mkdir -p "$REL"

# O diretório é publicado inteiro: o que não é página não sobe. A configuração
# do servidor, com a porta interna, não precisa virar URL.
rsync -a --delete \
  --exclude 'deploy/' \
  --exclude 'README*.md' \
  --exclude 'og.html' \
  --exclude 'make-og.mjs' \
  "$REPO/site/" "$REL/"

# Os arquivos de /assets/ ficam uma semana no cache da borda do Cloudflare, e
# mantêm o nome entre releases — então uma correção de CSS publicada não chega
# a ninguém até a semana virar. O endereço passa a carregar o hash do conteúdo:
# arquivo igual, mesmo endereço e mesmo cache; arquivo diferente, endereço
# diferente, e o cache velho deixa de ser consultado sozinho.
#
# A troca é feita na cópia da release, não no repositório: o que está
# versionado continua legível, sem sujeira de build.
for f in styles.css i18n.js main.js; do
  hash=$(md5sum "$REL/assets/$f" | cut -c1-8)
  sed -i "s|assets/$f\"|assets/$f?v=$hash\"|g" "$REL/index.html"
done

# O servidor fica ao lado do que ele serve, e não dentro do checkout: um
# serviço que aponta para o diretório de trabalho de alguém quebra no dia em
# que esse alguém move a pasta.
cp "$REPO/site/deploy/serve.mjs" "$BASE/serve.mjs"

ln -sfn "$REL" "$BASE/current.tmp"
mv -T "$BASE/current.tmp" "$BASE/current"

# Cinco releases é o suficiente para voltar atrás sem virar arquivo morto.
(cd "$RELEASES" && ls -1dt ./*/ | tail -n +6 | xargs -r rm -rf)

echo "publicado: $sha"
ls -1dt "$RELEASES"/*/ | head -5 | xargs -n1 basename
