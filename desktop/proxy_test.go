package main

import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
)

func TestContractValidation(t *testing.T) {
 for _,test:=range []struct{path,body string; want int}{
  {"/api/openai/models",`{"baseUrl":"","apiKey":"x"}`,400},
  {"/api/openai/chat/completions",`{"baseUrl":"https://example.com/v1","apiKey":"x"}`,400},
  {"/api/openai/tokenize",`{"baseUrl":"https://example.com/v1","apiKey":"x"}`,400},
  {"/api/openai/unknown",`{}`,404},
 } {
  req:=httptest.NewRequest(http.MethodPost,test.path,strings.NewReader(test.body))
  w:=httptest.NewRecorder()
  handleAPI(w,req)
  if w.Code!=test.want {t.Errorf("%s: got %d want %d",test.path,w.Code,test.want)}
 }
}
func TestModelsProxy(t *testing.T) {
 upstream:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
  if r.Method!="GET"||r.URL.Path!="/v1/models"||r.Header.Get("Authorization")!="Bearer secret" {t.Errorf("incorrect upstream request: %+v",r)}
  w.Header().Set("Content-Type","application/json")
  _,_=w.Write([]byte(`{"data":[{"id":"test"}]}`))
 }))
 defer upstream.Close()
 body,_:=json.Marshal(map[string]any{"baseUrl":upstream.URL+"/v1","apiKey":"secret"})
 w:=httptest.NewRecorder()
 handleAPI(w,httptest.NewRequest("POST","/api/openai/models",strings.NewReader(string(body))))
 if w.Code!=200||!strings.Contains(w.Body.String(),`"test"`) {t.Fatalf("got %d %s",w.Code,w.Body.String())}
}
func TestTokenizeFallback(t *testing.T) {
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(404)}))
 defer server.Close()
 body,_:=json.Marshal(map[string]any{"baseUrl":server.URL,"apiKey":"secret","payload":map[string]any{"model":"a","messages":[]any{map[string]any{"content":"hello"}}}})
 w:=httptest.NewRecorder()
 handleAPI(w,httptest.NewRequest("POST","/api/openai/tokenize",strings.NewReader(string(body))))
 if w.Code!=200 {t.Fatalf("status: %d",w.Code)}
 var response map[string]any
 if err:=json.Unmarshal(w.Body.Bytes(),&response);err!=nil{t.Fatal(err)}
 if response["source"]!="estimated"||response["upstream_status"]!=float64(404){t.Fatalf("got %+v",response)}
}
func TestChatStreaming(t *testing.T) {
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  if r.URL.Path!="/chat/completions"||r.Method!="POST"{t.Errorf("bad request %s",r.URL.Path)}
  w.Header().Set("Content-Type","text/event-stream")
  _,_=w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"))
 }))
 defer server.Close()
 body,_:=json.Marshal(map[string]any{"baseUrl":server.URL,"apiKey":"secret","payload":map[string]any{"stream":true}})
 w:=httptest.NewRecorder()
 handleAPI(w,httptest.NewRequest("POST","/api/openai/chat/completions",strings.NewReader(string(body))))
 if w.Code!=200||!strings.Contains(w.Body.String(),"[DONE]")||w.Header().Get("X-Accel-Buffering")!="no" {t.Fatalf("stream issue %d %s",w.Code,w.Body.String())}
}
