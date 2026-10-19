package main

import (
 "embed"
 "log"
 "net/http"

 "github.com/wailsapp/wails/v2"
 "github.com/wailsapp/wails/v2/pkg/options"
 "github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
 err := wails.Run(&options.App{
  Title: "Micro Shop Studio",
  Width: 1380,
  Height: 900,
  AssetServer: &assetserver.Options{
   Assets: assets,
   Handler: http.HandlerFunc(handleAPI),
  },
 })
 if err != nil { log.Fatal(err) }
}
