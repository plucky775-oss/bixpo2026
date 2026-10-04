import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const faq={id:1,product:"Power TBM",category:"현장질문",question:"무엇을 지원하나요?",short_answer:"현장 안전을 지원합니다.",detail:"상세 설명"};

function appContext(promptAnswers=[]){
  const requests=[],prompts=[];
  const doc={visibilityState:"visible",querySelector:()=>({innerHTML:"already-rendered"}),querySelectorAll:()=>[]};
  const context={
    window:{navigator:{userAgent:""},matchMedia:()=>({matches:false}),addEventListener(){},Notification:function(){},PushManager:function(){}},
    document:doc,navigator:{serviceWorker:{addEventListener(){},register:async()=>{},ready:Promise.resolve({pushManager:{getSubscription:async()=>null}})}},
    localStorage:{getItem:()=>""},location:new URL("https://bixpo.test/"),URLSearchParams,
    fetch:async(url,options={})=>{
      if(String(url).includes("/bixpo-faq-admin")){
        requests.push(JSON.parse(options.body||"{}"));
        return {ok:true,status:200,json:async()=>({})};
      }
      if(String(url).includes("/rest/v1/bixpo_faq"))return {ok:true,status:200,json:async()=>[faq]};
      return {ok:true,status:200,json:async()=>[]};
    },
    prompt:(label)=>{prompts.push(label);return promptAnswers.shift()??null;},
    alert(){},confirm:()=>true,setInterval(){},console,atob,Uint8Array,URL,
    Promise,Set,Map,Date,JSON,String,Array,Object,Math,Error
  };
  context.window.navigator.standalone=false;
  vm.runInNewContext(appSource,context);
  return {context,requests,prompts};
}

test("FAQ card displays the existing short_answer without the removed label and still searches it",()=>{
  const {context}=appContext();
  const html=vm.runInNewContext("FAQ=["+JSON.stringify(faq)+"];faqView()",context);
  assert.match(html,/현장 안전을 지원합니다\./);
  assert.equal(html.includes("10초 답변"),false);
  const matched=vm.runInNewContext("faqQuery='현장 안전';faqMatch(FAQ[0])",context);
  assert.equal(matched,true);
});

test("FAQ add flow asks for 핵심 답변 and saves it in short_answer",async()=>{
  const {context,requests,prompts}=appContext(["Power TBM","현장질문","새 질문","추가 답변","추가 설명"]);
  await context.addFAQ();
  assert.ok(prompts.includes("핵심 답변"));
  assert.equal(prompts.includes("10초 답변"),false);
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,"add");
  assert.equal(requests[0].item.short_answer,"추가 답변");
});

test("FAQ edit flow asks for 핵심 답변 and updates the existing short_answer",async()=>{
  const {context,requests,prompts}=appContext(["Safety 4-Cut","수정 분류","수정 질문","수정 답변","수정 설명"]);
  vm.runInNewContext("FAQ=["+JSON.stringify(faq)+"]",context);
  await context.editFAQ(1);
  assert.ok(prompts.includes("핵심 답변"));
  assert.equal(prompts.includes("10초 답변"),false);
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,"update");
  assert.equal(requests[0].item.short_answer,"수정 답변");
  assert.equal(requests[0].item.id,faq.id);
});
