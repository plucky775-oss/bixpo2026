import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const seed=JSON.parse(readFileSync(new URL('../data.json',import.meta.url),'utf8'));
const copy=value=>JSON.parse(JSON.stringify(value));
const person={id:'p1',name:'최재혁',down:'11/2(월) 오후 출발',up:'11/6(금) 오후 출발',stay:'11/2(체크인)~11/6(체크아웃)'};
const shift={id:'s4',date:'11/6(금)',period:'오전',time:'9-12',people:'최재혁, 신소망'};
const schedule=(p={},s={})=>({people:[{...person,...p}],shifts:[{...shift,...s}],tasks:[],notes:[]});

async function appContext(initial=seed){
  const nodes=new Map(),requests=[];
  let serverState=copy(initial);
  const document={querySelector(selector){
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:''});
    return nodes.get(selector);
  }};
  const context=vm.createContext({
    window:{addEventListener(){}},navigator:{},document,
    localStorage:{getItem:()=>''},location:new URL('https://bixpo.test/'),URLSearchParams,
    setInterval(){},alert(){},console,
    fetch:async(url,options={})=>{
      if(String(url).includes('/functions/v1/bixpo-admin')){
        const body=JSON.parse(options.body);
        requests.push(body);
        if(body.action==='save')serverState=copy(body.data);
        return {ok:true,json:async()=>({})};
      }
      return {ok:true,json:async()=>String(url).includes('/bixpo_state')?[{data:copy(serverState)}]:[]};
    }
  });
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {context,nodes,requests,run:code=>vm.runInContext(code,context),setServer:value=>{serverState=copy(value);}};
}

test('seed corrects only the weekday and retains the unresolved trip, booking and s4 assignment',()=>{
  const p=seed.people.find(p=>p.id==='p1'),s=seed.shifts.find(s=>s.id==='s4');
  assert.equal(new Date('2026-11-05T00:00:00Z').getUTCDay(),4);
  assert.equal(p.up,'11/5(목) 오후 출발(자차)');
  assert.equal(p.stay,'11/2(체크인)~11/6(체크아웃)');
  assert.deepEqual(s,{id:'s4',date:'11/6(금)',period:'오전',people:'최재혁,신소망',time:'9-12',note:''});
});

test('current seed detects s4 after return and both other after-return duties without mutating data',async()=>{
  const {context,run}=await appContext();
  const before=run('JSON.stringify(S)');
  const warnings=context.scheduleConflicts();
  assert.deepEqual(copy(warnings.filter(w=>w.level==='conflict').map(w=>w.person).sort()),['박근수','이상현','최재혁']);
  const target=warnings.find(w=>w.person==='최재혁'&&w.level==='conflict');
  assert.match(target.message,/11\/6\(금\) 오전 9-12 근무/);
  assert.match(target.message,/11\/5\(목\) 오후 출발\(자차\)/);
  assert.match(target.message,/복귀일 이후 근무/);
  assert.deepEqual(copy(target.days),[5,6]);
  assert.equal(run('JSON.stringify(S)'),before);
});

test('hotel extension is confirmation only; missing hotel does not imply inability to work',async()=>{
  const {context}=await appContext();
  const warnings=context.scheduleConflicts(schedule({up:'11/5(목) 오후 출발'}, {date:'11/4(수)'}));
  assert.equal(warnings.length,1);
  assert.equal(warnings[0].level,'review');
  assert.match(warnings[0].message,/체크아웃이 복귀일보다 늦습니다/);
  assert.equal(context.scheduleConflicts(schedule({stay:'미정'})).length,0);
});

test('valid trip, checkout and morning duty on return day produce no warning',async()=>{
  const {context}=await appContext(schedule());
  assert.equal(context.scheduleConflicts().length,0);
  assert.doesNotMatch(context.calendar(),/schedule-warnings|schedule-day-warning/);
  assert.match(context.calendar(),/전시근무/);
});

test('duties before departure and a reversed trip are flagged',async()=>{
  const {context}=await appContext();
  const warnings=context.scheduleConflicts(schedule({down:'11/5(목) 오후 출발'},{date:'11/4(수)'}));
  assert.equal(warnings.length,2); // Work before departure, plus earlier hotel check-in for confirmation.
  assert.equal(warnings.filter(w=>w.level==='conflict').length,1);
  assert.match(warnings[0].message,/출발일 이전 근무/);
  const reversed=context.scheduleConflicts(schedule({down:'11/7(토) 오후 출발'}));
  assert.ok(reversed.some(w=>w.level==='conflict'&&w.message.includes('출발일이 복귀일보다 늦습니다')));
});

test('same-day broad travel times request confirmation, while explicit overlapping times establish conflicts',async()=>{
  const {context}=await appContext();
  let warnings=context.scheduleConflicts(schedule({}, {period:'오후',time:'14-18'}));
  assert.equal(warnings.length,1);
  assert.equal(warnings[0].level,'review');
  for(const up of ['11/6 오후 1시 출발','11/6 13:30 출발']){
    warnings=context.scheduleConflicts(schedule({up},{time:'9-14'}));
    assert.equal(warnings.length,1);
    assert.equal(warnings[0].level,'conflict');
  }
  assert.equal(context.scheduleConflicts(schedule({up:'11/6 오후 12시 출발'})).length,0);
  assert.equal(context.scheduleConflicts(schedule({up:'11/6 오후 KTX 3시 출발'})).length,0);
  assert.equal(context.scheduleConflicts(schedule({up:'11/6 오후 1시~3시 출발'}, {time:'9-14'})).length,0);
  assert.equal(context.scheduleConflicts(schedule({up:'11/6 오후 출발'},{time:'9-14'}))[0].level,'review');
  assert.equal(context.scheduleConflicts(schedule({down:'11/6 오후 출발',stay:'미정'}))[0].level,'conflict');
});

test('unknown/invalid dates and times are not coerced into definite conflicts',async()=>{
  const {context}=await appContext();
  for(const value of ['미정','','11/0','11/31','11/123','10/31']){
    assert.equal(context.scheduleConflicts(schedule({up:value,down:value,stay:'미정'})).length,0);
  }
  for(const time of ['미정','','9:99-12','18-9']){
    assert.equal(context.scheduleConflicts(schedule({}, {time})).length,0);
  }
  assert.equal(context.scheduleConflicts(schedule({up:'11/6 25시 출발'})).length,0);
  assert.equal(context.scheduleConflicts(schedule({up:'11/5 오후 출발'}, {time:''})).filter(w=>w.level==='conflict').length,1);
});

test('comma-separated names match exactly, including spaces and unassigned shifts',async()=>{
  const {context}=await appContext();
  for(const people of ['최재혁, 신소망','신소망,\t최재혁 ']){
    assert.equal(context.scheduleConflicts(schedule({up:'11/5 오후 출발',stay:'미정'}, {people})).length,1);
  }
  for(const people of ['최재혁2','미배정','']){
    assert.equal(context.scheduleConflicts(schedule({up:'11/5 오후 출발',stay:'미정'}, {people})).length,0);
  }
});

test('calendar combines person and type filters while retaining original event grouping',async()=>{
  const {context,run}=await appContext();
  run("personFilter='최재혁';typeFilter='shift'");
  assert.deepEqual(copy(context.events(6)),[['shift','● 오전 9-12 · 최재혁,신소망']]);
  let html=context.calendar();
  assert.match(html,/복귀일 이후 근무/);
  assert.doesNotMatch(html,/체크아웃이 복귀일보다 늦습니다/);
  assert.doesNotMatch(html,/class="daygroup (depart|stay|return|prep)"/);
  assert.deepEqual([...new Set(context.visibleScheduleConflicts().map(w=>w.person))],['최재혁']);
  run("typeFilter='travel'");
  assert.deepEqual(copy(context.events(5)),[['return','↑ 최재혁 복귀 · 11/5(목) 오후 출발(자차)']]);
  assert.match(context.calendar(),/복귀일 이후 근무/);
  run("typeFilter='stay'");
  assert.match(context.calendar(),/체크아웃이 복귀일보다 늦습니다/);
  assert.doesNotMatch(context.calendar(),/복귀일 이후 근무/);
  run("typeFilter='prep'");
  assert.deepEqual(copy(context.events(6)),[['prep','◆ 부스 철거 · 최재혁, 신소망']]);
  assert.doesNotMatch(context.calendar(),/schedule-warnings/);
  run("personFilter='신소망';typeFilter='전체'");
  assert.doesNotMatch(context.calendar(),/schedule-warnings/);
  html=context.calendar();
  assert.ok(html.indexOf('class="daygroup shift"')<html.indexOf('class="daygroup prep"'));
  assert.ok(html.lastIndexOf('class="daygroup prep"')<html.lastIndexOf('class="daygroup return"'));
});

test('calendar marks both conflicting dates and administrator views show all warnings regardless of calendar filters',async()=>{
  const {context,run,nodes}=await appContext();
  run("personFilter='최재혁';typeFilter='shift'");
  const html=context.calendar();
  assert.match(html,/<div class="num">5 목<\/div><div class="schedule-day-warning"/);
  assert.match(html,/<div class="num">6 금<\/div><div class="schedule-day-warning"/);
  run("personFilter='조병희';typeFilter='prep';admin=true");
  for(const tab of ['adminpanel','people','shifts']){
    run(`tab=${JSON.stringify(tab)};render()`);
    const view=nodes.get('#view').innerHTML;
    assert.match(view,/충돌 3건/);
    assert.match(view,/<b>최재혁<\/b> · 11\/6\(금\) 오전 9-12 근무/);
    assert.match(view,/<b>박근수<\/b> · 11\/5/);
  }
  run('admin=false');
  assert.doesNotMatch(context.adminPanel(),/schedule-warnings/);
});

test('server-loaded legacy data is checked without rewriting it and corrected data clears warnings on reload',async()=>{
  const legacy=schedule({up:'11/5(금) 오후 출발'});
  const {context,run,setServer,nodes}=await appContext(legacy);
  assert.match(nodes.get('#view').innerHTML,/복귀일 이후 근무/);
  assert.equal(run('S.people[0].up'),'11/5(금) 오후 출발');
  setServer(schedule());
  await context.load();
  assert.doesNotMatch(nodes.get('#view').innerHTML,/schedule-warnings|schedule-day-warning/);
  assert.equal(run('S.people[0].up'),'11/6(금) 오후 출발');
});

test('rendering and saving warnings never persists derived warnings or silently resolves the conflict',async()=>{
  const {context,run,requests}=await appContext();
  run("admin=true;tab='shifts';render()");
  assert.equal(await context.persist(),true);
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,'save');
  assert.deepEqual(requests[0].data,seed);
  assert.match(context.calendar(),/복귀일 이후 근무/);
});

test('warning text escapes untrusted names and itinerary text',async()=>{
  const {context}=await appContext();
  const warnings=context.scheduleConflicts(schedule({name:'<img src=x onerror=alert(1)>',up:'11/5 <script>bad</script>',stay:'미정'}, {people:'<img src=x onerror=alert(1)>'}));
  const html=context.scheduleWarnings(warnings)+context.scheduleDayWarning(warnings,6);
  assert.match(html,/&lt;img/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<img|<script/);
});

test('preparation tasks keep owner filtering, incomplete-first due-date sorting, stable ties and original edit indexes',async()=>{
  const state=schedule();
  state.tasks=[
    {title:'완료빠름',owner:'최재혁',due:'10/1',done:true},
    {title:'나중',owner:'최재혁',due:'11/3',done:false},
    {title:'먼저A',owner:'최재혁, 정승훈',due:'10/31',done:false},
    {title:'다른사람',owner:'신소망',due:'10/1',done:false},
    {title:'기한미정',owner:'최재혁',due:'미정',done:false},
    {title:'먼저B',owner:'최재혁',due:'10/31',done:false}
  ];
  const {run,nodes}=await appContext(state);
  run("admin=true;tab='tasks';taskPersonFilter='최재혁';render()");
  const html=nodes.get('#view').innerHTML;
  assert.deepEqual([...html.matchAll(/<b>[○✓] ([^<]+)<\/b>/g)].map(m=>m[1]),['먼저A','먼저B','나중','기한미정','완료빠름']);
  assert.deepEqual([...html.matchAll(/onclick="editTask\((\d+)\)"/g)].map(m=>+m[1]),[2,5,1,4,0]);
  assert.doesNotMatch(html,/다른사람|schedule-warnings/);
});
