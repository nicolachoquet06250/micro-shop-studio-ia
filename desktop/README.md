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
des artefacts de chaque exécution. Aucune release n'est créée.
Après réussite, ouvrir **Actions → Desktop portable builds → exécution → Artifacts**.

Le frontend nécessite un navigateur embarqué disposant des fonctionnalités
WebContainer, PHP.wasm et Wasmer. Le moteur WebView natif est différent de
Chrome/Firefox de bureau : la parité des validateurs doit être vérifiée
sur les trois OS, notamment pour `SharedArrayBuffer` et la cross-origin
isolation. Les builds réussis ne constituent pas à eux seuls une preuve
de compatibilité de tous les validateurs en exécution.

## Packages GitHub (GHCR)

Sur chaque push réussi vers `main`, après réussite des builds des trois systèmes,
la CI publie les archives portables au format **OCI artifact** dans GitHub Packages,
sans créer de GitHub Release. Les artefacts Actions restent disponibles.

Package : `ghcr.io/nicolachoquet06250/micro-shop-studio-ia/micro-shop-studio-desktop`

Tags remplacés automatiquement par le prochain build réussi :

- `linux-x64-latest`
- `windows-x64-latest`
- `macos-arm64-latest`

Chaque compilation est aussi accessible par `sha-<commit>-<plateforme>`.
Ces tags précis restent stables ; le registre peut conserver les blobs anciens
jusqu'à suppression ou à l'application d'une politique de rétention.

Exemple pour récupérer le binaire Linux :

```sh
oras pull ghcr.io/nicolachoquet06250/micro-shop-studio-ia/micro-shop-studio-desktop:linux-x64-latest
tar -xzf artifacts/micro-shop-studio-linux-x64/packages/micro-shop-studio-linux-x64.tar.gz
```

L'archive est publiée dans GHCR sous le nom de fichier et l'arborescence
`artifacts/micro-shop-studio-<plateforme>/packages/` indiqués ci-dessus.
L'accès au package dépend de sa visibilité GHCR (public/privé).
Si besoin, se connecter avec `oras login ghcr.io`.

Le job de publication ne s'exécute jamais sur une PR ; il nécessite
`packages: write` et un `GITHUB_TOKEN` autorisé. Avant publication,
il vérifie que son commit correspond toujours au HEAD de `main` afin
qu'un build ancien ne remplace pas accidentellement les tags `latest`.
