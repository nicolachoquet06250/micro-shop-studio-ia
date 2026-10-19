package main

import (
 "embed"
 "io/fs"
 "log"
 "net/http"

 "github.com/wailsapp/wails/v2"
 "github.com/wailsapp/wails/v2/pkg/options"
 "github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
 static,err:=fs.Sub(assets,"frontend/dist")
 if err!=nil{log.Fatal(err)}
 bridge,err:=NewBridge()
 if err!=nil{log.Fatal(err)}
 defer bridge.Close()
 err = wails.Run(&options.App{
  Title: "Micro Shop Studio",
  Width: 1380,
  Height: 900,
  MinWidth: 960,
  MinHeight: 640,
  Bind: []interface{}{bridge},
  AssetServer: &assetserver.Options{
   Assets: static,
   Handler: http.HandlerFunc(handleAPI),
  },
 })
 if err != nil {log.Fatal(err)}
}
