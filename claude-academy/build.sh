#!/bin/sh
# Genera index.html (PWA installabile) da app.html, che resta la sorgente unica.
cd "$(dirname "$0")"
{
  printf '%s\n' '<!DOCTYPE html>' '<html lang="it">' '<head>' '<meta charset="UTF-8">' \
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">' \
    '<meta name="apple-mobile-web-app-capable" content="yes">' \
    '<meta name="apple-mobile-web-app-title" content="Guru Claude">' \
    '<meta name="theme-color" content="#2f3fb0">' \
    '<link rel="manifest" href="manifest.json">' \
    '<link rel="icon" type="image/svg+xml" href="icon.svg">' \
    '<link rel="apple-touch-icon" href="icon.svg">' \
    '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}img{max-width:100%}</style>' \
    '</head>' '<body>'
  cat app.html
  printf '%s\n' '</body>' '</html>'
} > index.html
