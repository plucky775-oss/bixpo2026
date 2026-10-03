import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {chatImagePathOwnedBy,chatMessageNotificationBody,chatMessageParts,chatPushPayload,isChatImagePath,selectChatPushRecipients} from "../supabase/functions/bixpo-push/push-utils.mjs";

const workerSource=readFileSync(new URL("../sw.js",import.meta.url),"utf8");
const appSource=readFileSync(new URL("../app.js",import.meta.url),"utf8");

function fakeWindow(visibilityState){
  const messages=[];
  return {visibilityState,messages,postMessage(message){messages.push(message)},navigate(){},focus(){}};
}

async function pushInState(payload,windows){
  const listeners=new Map(),notifications=[];
  const clients={matchAll:async()=>windows,openWindow:async url=>url};
  const self={
    addEventListener:(name,handler)=>listeners.set(name,handler),
    skipWaiting:()=>Promise.resolve(),
    clients,
    location:{origin:"https://bixpo.test"},
    registration:{showNotification:async(...args)=>notifications.push(args)}
  };
  const context={self,clients,location:self.location,URL,fetch:async()=>{},caches:{open:async()=>({addAll:async()=>{}}),match:async()=>{}}};
  vm.runInNewContext(workerSource,context);
  const pending=[];
  listeners.get("push")({data:{json:()=>payload},waitUntil:p=>pending.push(p)});
  await Promise.all(pending);
  return {notifications,windows};
}

function appContext({visibilityState,subscription=null}){
  const notifications=[],sounds=[];
  const doc={visibilityState,querySelector:()=>({innerHTML:"already-rendered"})};
  const notification=function(title,options){notifications.push({title,options})};
  notification.permission="granted";
  const audioContext=function(){
    this.currentTime=0;
    this.destination={};
    this.createOscillator=()=>({frequency:{},connect(){},start(){sounds.push("start")},stop(){}});
    this.createGain=()=>({gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}});
  };
  const registration={pushManager:{getSubscription:async()=>subscription}};
  const serviceWorker={addEventListener(){},register:async()=>{},ready:Promise.resolve(registration)};
  const window={AudioContext:audioContext,webkitAudioContext:null,Notification:notification,PushManager:function(){},navigator:{userAgent:""},matchMedia:()=>({matches:false}),addEventListener(){}};
  window.navigator.standalone=false;
  const context={
    window,document:doc,navigator:{serviceWorker},Notification:notification,
    localStorage:{getItem:()=>""},location:new URL("https://bixpo.test/"),
    URLSearchParams,fetch:async()=>({ok:true,json:async()=>[]}),
    setInterval(){},alert(){},console,atob,Uint8Array,URL,
    caches:{},Promise,Set,Map,Date,JSON,String,Array,Object,Math,Error
  };
  vm.runInNewContext(appSource,context);
  return {context,notifications,sounds};
}

test("chat push excludes the sender's account and sending device only",()=>{
  const rows=[
    {endpoint:"sender-current",subscription:{staff_name:"민수"}},
    {endpoint:"sender-other",subscription:{staff_name:"민수"}},
    {endpoint:"other-staff",subscription:{staff_name:"지수"}},
    {endpoint:"legacy-current",subscription:{}},
    {endpoint:"legacy-other",subscription:{}}
  ];
  const recipients=selectChatPushRecipients(rows,"민수","legacy-current");
  assert.deepEqual(recipients.map(row=>row.endpoint),["other-staff","legacy-other"]);
});

test("an active app receives chat push in-page without a second system notification",async()=>{
  const chat={id:42,staff_name:"지수",message:"집결 장소가 변경됐습니다."};
  const window=fakeWindow("visible");
  const result=await pushInState(chatPushPayload(chat),[window]);
  assert.equal(result.notifications.length,0);
  assert.deepEqual(JSON.parse(JSON.stringify(window.messages)),[{type:"bixpo_chat_push",chat}]);
});

test("background and closed apps receive one service-worker notification",async()=>{
  const payload=chatPushPayload({id:43,staff_name:"지수",message:"확인 바랍니다."});
  const background=await pushInState(payload,[fakeWindow("hidden")]);
  const closed=await pushInState(payload,[]);
  assert.equal(background.notifications.length,1);
  assert.equal(background.notifications[0][1].tag,"bixpo-chat-43");
  assert.equal(closed.notifications.length,1);
  assert.equal(closed.notifications[0][1].tag,"bixpo-chat-43");
});

test("notice push still displays while an app window is visible",async()=>{
  const result=await pushInState({title:"공지",body:"안내",url:"/"},[fakeWindow("visible")]);
  assert.equal(result.notifications.length,1);
  assert.equal(result.notifications[0][1].tag,"bixpo-notice");
});

test("chat sound stays active and local notifications are deduplicated or suppressed for push devices",async()=>{
  const active=appContext({visibilityState:"visible"});
  await active.context.notifyChat({id:51,staff_name:"지수",message:"활성 알림"});
  await active.context.notifyChat({id:51,staff_name:"지수",message:"활성 알림"});
  assert.equal(active.sounds.length,1);
  assert.equal(active.notifications.length,0);

  const subscribed=appContext({visibilityState:"hidden",subscription:{endpoint:"https://push.test",keys:{}}});
  await subscribed.context.notifyChat({id:52,staff_name:"지수",message:"Push 알림"});
  assert.equal(subscribed.notifications.length,0);

  const fallback=appContext({visibilityState:"hidden"});
  await fallback.context.notifyChat({id:53,staff_name:"지수",message:"로컬 알림"});
  await fallback.context.notifyChat({id:53,staff_name:"지수",message:"로컬 알림"});
  assert.equal(fallback.notifications.length,1);
  assert.equal(fallback.notifications[0].options.body,"로컬 알림");
});


test("chat image markers stay hidden from message text and push notifications",()=>{
  const path="chat/"+encodeURIComponent("민수")+"/01234567-89ab-cdef-0123-456789abcdef.jpg";
  const message="집결 장소가 변경됐습니다."+String.fromCharCode(10)+"[[bixpo-image:"+path+"]]";
  assert.equal(isChatImagePath(path),true);
  assert.equal(chatImagePathOwnedBy(path,"민수"),true);
  assert.equal(chatImagePathOwnedBy(path,"지수"),false);
  assert.deepEqual(chatMessageParts(message),{text:"집결 장소가 변경됐습니다.",imagePath:path});
  assert.equal(chatMessageNotificationBody(message),"집결 장소가 변경됐습니다. · 📷 사진");
  assert.equal(chatMessageNotificationBody("[[bixpo-image:"+path+"]]"),"📷 사진");
  const payload=chatPushPayload({id:77,staff_name:"민수",message});
  assert.equal(payload.body,"집결 장소가 변경됐습니다. · 📷 사진");
  assert.equal(payload.body.includes("[[bixpo-image:"),false);
});

test("chat image path validation rejects arbitrary object keys",()=>{
  assert.equal(isChatImagePath("other/file.jpg"),false);
  assert.equal(isChatImagePath("chat/민수/not-a-uuid.jpg"),false);
});

test("chat view adds a photo picker and renders signed private photos",()=>{
  const app=appContext({visibilityState:"visible"});
  const path="chat/민수/01234567-89ab-cdef-0123-456789abcdef.jpg";
  const message="현장 위치 사진입니다."+String.fromCharCode(10)+"[[bixpo-image:"+path+"]]";
  const rows=[{id:78,staff_name:"민수",message,created_at:"2026-10-03T00:00:00Z"}];
  const setup="staff={name:'민수',role:'staff'};CHAT="+JSON.stringify(rows)+";chatImageUrls.set("+JSON.stringify(path)+",{url:'https://example.supabase.co/storage/v1/object/sign/bixpo-chat/photo?token=x',expiresAt:Date.now()+3600000});chatView()";
  const html=vm.runInNewContext(setup,app.context);
  assert.match(html,/aria-label="사진 첨부"/);
  assert.match(html,/id="chatImageInput"/);
  assert.match(html,/현장 위치 사진입니다/);
  assert.match(html,/alt="채팅 첨부 사진"/);
  assert.equal(html.includes("[[bixpo-image:"),false);
});
