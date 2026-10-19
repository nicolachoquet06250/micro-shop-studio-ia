package main

import (
 "bytes"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "strings"
 "sync"
)

type proxyInput struct {
 BaseURL string `json:"baseUrl"`
 APIKey string `json:"apiKey"`
 Payload json.RawMessage `json:"payload"`
}
var unsupportedTokenizers sync.Map

func jsonError(w http.ResponseWriter,status int,kind,message string) {
 w.Header().Set("Content-Type","application/json; charset=utf-8")
 w.Header().Set("Cache-Control","no-store")
 w.WriteHeader(status)
 _=json.NewEncoder(w).Encode(map[string]any{"error":map[string]string{"type":kind,"message":message}})
}
func handleAPI(w http.ResponseWriter,r *http.Request) {
 if !strings.HasPrefix(r.URL.Path,"/api/openai/") { http.NotFound(w,r);return }
 w.Header().Set("Cross-Origin-Opener-Policy","same-origin")
 w.Header().Set("Cross-Origin-Embedder-Policy","require-corp")
 if r.Method!="POST" {jsonError(w,405,"invalid_proxy_request","Méthode non autorisée.");return}
 path:=strings.TrimPrefix(r.URL.Path,"/api/openai/")
 suffix,method:="","POST"
 switch path {
 case "models":suffix="/models";method="GET"
 case "chat/completions":suffix="/chat/completions"
 case "tokenize":suffix="/tokenize"
 default:http.NotFound(w,r);return
 }
 var input proxyInput
 if err:=json.NewDecoder(io.LimitReader(r.Body,32<<20)).Decode(&input);err!=nil{
  jsonError(w,400,"invalid_proxy_request","Corps de requête invalide.");return
 }
 input.BaseURL=strings.TrimSpace(input.BaseURL)
 input.APIKey=strings.TrimSpace(input.APIKey)
 if input.BaseURL=="" {jsonError(w,400,"invalid_proxy_request","L'URL de base de l'API est requise.");return}
 if input.APIKey=="" {jsonError(w,400,"invalid_proxy_request","La clé API est requise.");return}
 var payload map[string]any
 if path!="models" && (len(input.Payload)==0 || json.Unmarshal(input.Payload,&payload)!=nil || payload==nil) {
  message:="Le payload OpenAI est requis."
  if path=="tokenize" {message="Le payload de tokenisation est requis."}
  jsonError(w,400,"invalid_proxy_request",message);return
 }
 base:=strings.TrimRight(input.BaseURL,"/")
 parsed,err:=url.Parse(base)
 if err!=nil || parsed.Host=="" || parsed.User!=nil || (parsed.Scheme!="http" && parsed.Scheme!="https") {
  jsonError(w,400,"invalid_proxy_request","L'URL de base de l'API est invalide.");return
 }
 key:=base+"::"+fmt.Sprint(payload["model"])
 if path=="tokenize" {if _,found:=unsupportedTokenizers.Load(key);found {sendEstimate(w,payload,0);return}}
 var body io.Reader
 if method=="POST" {body=bytes.NewReader(input.Payload)}
 req,err:=http.NewRequestWithContext(r.Context(),method,base+suffix,body)
 if err!=nil {jsonError(w,400,"invalid_proxy_request",err.Error());return}
 req.Header.Set("Authorization","Bearer "+input.APIKey)
 if method=="POST" {req.Header.Set("Content-Type","application/json")}
 if path=="chat/completions" {req.Header.Set("Accept","text/event-stream, application/json")} else {req.Header.Set("Accept","application/json")}
 if parsed.Hostname()=="api.anthropic.com" {req.Header.Set("anthropic-version","2023-06-01")}
 resp,err:=http.DefaultClient.Do(req)
 if err!=nil {
  if path=="tokenize" {sendEstimate(w,payload,502);return}
  if r.Context().Err()!=nil {jsonError(w,499,"request_aborted","La requête vers l’API OpenAI-compatible a été annulée.");return}
  jsonError(w,502,"upstream_connection_error","Impossible de joindre l'API OpenAI-compatible: "+err.Error());return
 }
 defer resp.Body.Close()
 if path=="tokenize" && (resp.StatusCode<200 || resp.StatusCode>=300) {
  switch resp.StatusCode {case 404,405,410,501:unsupportedTokenizers.Store(key,true)}
  sendEstimate(w,payload,resp.StatusCode);return
 }
 ct:=resp.Header.Get("Content-Type")
 if ct=="" {ct="application/json; charset=utf-8"}
 sse:=strings.Contains(strings.ToLower(ct),"text/event-stream")
 w.Header().Set("Content-Type",ct)
 if sse {w.Header().Set("Cache-Control","no-cache, no-transform");w.Header().Set("X-Accel-Buffering","no")
 } else {w.Header().Set("Cache-Control","no-store")}
 for _,k:=range []string{"X-Request-Id","Openai-Processing-Ms","Retry-After"}{if v:=resp.Header.Get(k);v!=""{w.Header().Set(k,v)}}
 w.WriteHeader(resp.StatusCode)
 if sse {
  buf:=make([]byte,4096)
  flusher,_:=w.(http.Flusher)
  for {n,e:=resp.Body.Read(buf);if n>0 {if _,writeErr:=w.Write(buf[:n]);writeErr!=nil{return};if flusher!=nil{flusher.Flush()}};if e!=nil{return}}
 }
 _,_=io.Copy(w,resp.Body)
}
func estimateText(s string) int {
 n:=0
 for _,r:=range s {n++;if r>0xffff{n++}}
 if n==0{return 0};return (n+2)/3
}
func estimateTokens(payload map[string]any) int {
 if messages,ok:=payload["messages"].([]any);ok&&len(messages)>0{
  count:=4
  for _,raw:=range messages {
   msg,ok:=raw.(map[string]any);if !ok{continue}
   content,_:=msg["content"].(string)
   if parts,ok:=msg["content"].([]any);ok{
    var out []string
    for _,part:=range parts {
     text:=""
     if p,ok:=part.(map[string]any);ok {
      if p["type"]=="text" {text,_=p["text"].(string)}
      if p["type"]=="image_url" {text="[IMAGE]"}
     }
     out=append(out,text)
    }
    content=strings.Join(out,"\n")
   }
   count+=8+estimateText(content)
  }
  return count
 }
 for _,field:=range []string{"prompt","text","input"}{if value,ok:=payload[field].(string);ok{return estimateText(value)}}
 b,_:=json.Marshal(payload);return estimateText(string(b))
}
func sendEstimate(w http.ResponseWriter,payload map[string]any,status int) {
 result:=map[string]any{"count":estimateTokens(payload),"source":"estimated","tokenizer":"local-conservative-estimate"}
 if status!=0 {result["upstream_status"]=status}
 w.Header().Set("Cache-Control","no-store")
 w.Header().Set("Content-Type","application/json; charset=utf-8")
 _=json.NewEncoder(w).Encode(result)
}
