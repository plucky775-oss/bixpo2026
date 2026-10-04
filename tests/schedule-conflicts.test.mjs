import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource=readFileSync(new URL("../app.js",import.meta.url),"utf8");
function appContext(){
  const document={visibilityState:"visible",querySelector:()=>({innerHTML:"already-rendered"}),querySelectorAll:()=>[]};
  const context={
    window:{navigator:{userAgent:""},matchMedia:()=>({matches:false}),addEventListener(){},Notification:function(){},PushManager:function(){}},
    document,navigator:{serviceWorker:{addEventListener(){},register:async()=>{},ready:Promise.resolve({pushManager:{getSubscription:async()=>null}})}},
    localStorage:{getItem:()=>""},location:new URL("https://bixpo.test/"),URLSearchParams,
    fetch:async()=>({ok:true,status:200,json:async()=>[]}),prompt:()=>null,alert(){},confirm:()=>true,setInterval(){},console,atob,Uint8Array,URL,
    Promise,Set,Map,Date,JSON,String,Array,Object,Math,Error
  };
  context.window.navigator.standalone=false;
  vm.runInNewContext(appSource,context);
  return context;
}
const person={id:"p1",name:"최재혁",up:"11/5(금) 오후 출발(자차)",down:"11/2(월) 오후 출발(자차)",stay:"11/2(체크인)~11/6(체크아웃)"};
const shift={id:"s4",date:"11/6(금)",period:"오전",time:"9-12",people:"최재혁,신소망"};

test("a shift after the listed return date is reported without changing either schedule",()=>{
  const context=appContext();
  vm.runInNewContext("S={people:"+JSON.stringify([person])+",shifts:"+JSON.stringify([shift])+"}",context);
  const conflicts=vm.runInNewContext("scheduleConflicts()",context);
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].person,"최재혁");
  assert.equal(conflicts[0].shift.id,"s4");
  assert.equal(vm.runInNewContext("S.people[0].up",context),person.up);
  assert.equal(vm.runInNewContext("S.shifts[0].people",context),shift.people);
});

test("calendar and administrator screen both show the unresolved conflict",()=>{
  const context=appContext();
  vm.runInNewContext("S={people:"+JSON.stringify([person])+",shifts:"+JSON.stringify([shift])+"};admin=true",context);
  const calendar=vm.runInNewContext("calendar()",context);
  const adminPanel=vm.runInNewContext("adminPanel()",context);
  for(const html of [calendar,adminPanel]){
    assert.match(html,/일정 충돌 확인 필요/);
    assert.match(html,/최재혁/);
    assert.match(html,/11\/6\(금\).*오전.*9-12/);
    assert.match(html,/관리자 확인 필요/);
  }
});

test("weekday display is derived from the 2026 calendar date, not the stored weekday text",()=>{
  const context=appContext();
  const corrected=vm.runInNewContext("fixScheduleWeekday('11/5(금) 오후 출발(자차)')",context);
  assert.equal(corrected,"11/5(목) 오후 출발(자차)");
  vm.runInNewContext("S={people:"+JSON.stringify([person])+",shifts:[]}",context);
  const calendar=vm.runInNewContext("calendar()",context);
  assert.match(calendar,/11\/5\(목\) 오후 출발/);
  assert.doesNotMatch(calendar,/11\/5\(금\)/);
});

test("a shift on the listed return date and an unassigned shift are not reported",()=>{
  const context=appContext();
  const sameDay={...shift,date:"11/5(목)"};
  const unassigned={...shift,date:"11/7(토)",people:"미배정"};
  vm.runInNewContext("S={people:"+JSON.stringify([person])+",shifts:"+JSON.stringify([sameDay,unassigned])+"}",context);
  assert.equal(vm.runInNewContext("scheduleConflicts().length",context),0);
});

test("current schedule data flags the 11/5 departure versus 11/6 shift for administrator review",()=>{
  const data=JSON.parse(readFileSync(new URL("../data.json",import.meta.url),"utf8"));
  const context=appContext();
  vm.runInNewContext("S="+JSON.stringify(data),context);
  const conflicts=vm.runInNewContext("scheduleConflicts()",context);
  assert.ok(conflicts.some(conflict=>conflict.person==="최재혁"&&conflict.shift.id==="s4"));
  const notice=vm.runInNewContext("scheduleConflictNotice()",context);
  assert.match(notice,/최재혁/);
  assert.match(notice,/11\/6\(금\).*오전.*9-12/);
});
