# Micro Shop Studio — application portable Go

L'application desktop utilise **Wails v2 + Go**, sans serveur Node au runtime.
Le frontend Vue 3 est partagé avec le site Astro, compilé séparément avec Vite.
Les trois routes `POST /api/openai/{models,chat/completions,tokenize}`
sont conservées et servies par Go.

## Compilation locale

Prérequis : Go 1.23, Node 22, dépendances natives Wails (WebKit2GTK
sur Linux, WebView2 sur Windows, WebKit sur macOS).

Depuis la racine du dépôt :

```sh
npm ci
./node_modules/.bin/vite build --config desktop/frontend/vite.config.ts
cd desktop
go mod tidy
go test ./...
go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2
wails build -s -skipbindings
```

Sur Ubuntu 24.04, utiliser `libwebkit2gtk-4.1-dev` et
`wails build -s -skipbindings -tags webkit2_41`.

Les binaires natifs sont créés dans `desktop/build/bin/`.

## Streaming Windows

Wails v2 ne prend pas en charge le streaming SSE depuis son asset handler
sous Windows. Une passerelle HTTP Go liée exclusivement à `127.0.0.1`,
avec jeton aléatoire par processus et origine CORS limitée à Wails,
sert donc **toutes** les routes API. Le wrapper `fetch` du frontend
préserve les chemins et payloads déjà utilisés par le site.

La passerelle est active uniquement pendant l'exécution de l'application.
Aucun secret API n'est persisté dans le backend Go.

## Artefacts GitHub Actions

Le workflow `desktop.yml` tourne sur Ubuntu, Windows et macOS et publie
des artefacts de chaque exécution et met à jour la release permanente `Builds` (tag `latest`) après réussite des trois builds sur `main`.
Après réussite, ouvrir **Actions → Desktop portable builds → exécution → Artifacts**.

Le frontend nécessite un navigateur embarqué disposant des fonctionnalités
WebContainer, PHP.wasm et Wasmer. Le moteur WebView natif est différent de
Chrome/Firefox de bureau : la parité des validateurs doit être vérifiée
sur les trois OS, notamment pour `SharedArrayBuffer` et la cross-origin
isolation. Les builds réussis ne constituent pas à eux seuls une preuve
de compatibilité de tous les validateurs en exécution.

## Téléchargements permanents — release Builds

La CI conserve **une seule release stable**, nommée `Builds`, avec le tag `latest`.
Elle est créée au premier build réussi de `main`, puis mise à jour après chaque
nouveau build réussi des trois plateformes. Les archives précédentes sont remplacées
grâce à `gh release upload --clobber`. Le tag `latest` pointe vers le dernier
commit publié, et les liens de téléchargement restent identiques :

- [Linux x64](https://github.com/nicolachoquet06250/micro-shop-studio-ia/releases/latest/download/MicroShopStudio-Linux-x64.tar.gz)
- [Windows x64](https://github.com/nicolachoquet06250/micro-shop-studio-ia/releases/latest/download/MicroShopStudio-Windows-x64.zip)
- [macOS Apple Silicon](https://github.com/nicolachoquet06250/micro-shop-studio-ia/releases/latest/download/MicroShopStudio-macOS-arm64.zip)

La publication ne s'exécute ni sur les PR ni tant que l'un des trois builds échoue.
Elle vérifie également que le commit en cours correspond encore à `main`, et sérialise
les publications pour qu'un ancien build ne remplace pas une version plus récente.
Les artefacts GitHub Actions continuent d'être publiés pour chaque exécution.

**Important** : la publication de nouvelles versions dans GHCR a été arrêtée.
Les anciens packages GHCR ne sont pas automatiquement supprimés.
