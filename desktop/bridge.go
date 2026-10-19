package main

import (
 "crypto/rand"
 "encoding/hex"
 "net"
 "net/http"
)

type Bridge struct {
 listener net.Listener
 token string
}
func NewBridge() (*Bridge,error) {
 ln,err:=net.Listen("tcp","127.0.0.1:0")
 if err!=nil{return nil,err}
 secret:=make([]byte,32)
 if _,err:=rand.Read(secret);err!=nil{_ = ln.Close();return nil,err}
 b:=&Bridge{listener:ln,token:hex.EncodeToString(secret)}
 server:=&http.Server{Handler:http.HandlerFunc(b.handle)}
 go func(){_ = server.Serve(ln)}()
 return b,nil
}
func (b *Bridge) APIBaseURL() string {return "http://"+b.listener.Addr().String()}
func (b *Bridge) AuthToken() string{return b.token}
func (b *Bridge) Close() { _=b.listener.Close() }
func (b *Bridge) handle(w http.ResponseWriter,r *http.Request) {
 origin:=r.Header.Get("Origin")
 if origin!="" {
  if origin!="http://wails.localhost" && origin!="https://wails.localhost" {
   http.Error(w,"Forbidden",http.StatusForbidden);return
  }
  w.Header().Set("Access-Control-Allow-Origin",origin)
  w.Header().Set("Vary","Origin")
  w.Header().Set("Access-Control-Allow-Headers","Content-Type, X-Micro-Shop-Token")
  w.Header().Set("Access-Control-Allow-Methods","POST, OPTIONS")
 }
 w.Header().Set("Cross-Origin-Resource-Policy","cross-origin")
 if r.Method=="OPTIONS" {w.WriteHeader(204);return}
 if r.Header.Get("X-Micro-Shop-Token")!=b.token {http.Error(w,"Forbidden",http.StatusForbidden);return}
 handleAPI(w,r)
}
