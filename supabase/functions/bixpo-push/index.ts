import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import {chatImagePathOwnedBy, chatPushPayload, chatStaffFolder, isChatImagePath, selectChatPushRecipients} from "./push-utils.mjs";

const H={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Content-Type":"application/json"
};
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CHAT_BUCKET="bixpo-chat";
const CHAT_IMAGE_TYPES=new Set(["image/jpeg","image/png","image/webp"]);
const CHAT_IMAGE_MAX_BYTES=2*1024*1024;

function reply(body:unknown,status=200){
  return new Response(JSON.stringify(body),{status,headers:H});
}

async function keys(){
  const {data}=await db.from("bixpo_push_config").select("*").eq("id","main").maybeSingle();
  if(data)return data;
  const k=webpush.generateVAPIDKeys();
  const q=await db.from("bixpo_push_config").insert({id:"main",public_key:k.publicKey,private_key:k.privateKey}).select().single();
  if(q.error)throw q.error;
  return q.data;
}

async function staffForToken(token:string){
  if(!token)return null;
  const session=await db.from("bixpo_staff_sessions").select("staff_name,expires_at").eq("token",token).maybeSingle();
  if(!session.data||new Date(session.data.expires_at).getTime()<=Date.now())return null;
  const staff=await db.from("bixpo_staff").select("name,active,role").eq("name",session.data.staff_name).maybeSingle();
  return staff.data?.active?staff.data:null;
}

async function saveSubscription(b:any){
  if(!b.subscription?.endpoint)return reply({error:"invalid_subscription"},400);
  const old=await db.from("bixpo_push_subscriptions").select("subscription").eq("endpoint",b.subscription.endpoint).maybeSingle();
  if(old.error)throw old.error;

  const {staff_name:_untrustedStaffName,...cleanSubscription}=b.subscription;
  let owner=old.data?.subscription?.staff_name||null;
  if(b.token){
    const staff=await staffForToken(String(b.token));
    if(!staff)return reply({error:"unauthorized"},401);
    owner=staff.name;
  }
  const subscription=owner?{...cleanSubscription,staff_name:owner}:cleanSubscription;
  const q=await db.from("bixpo_push_subscriptions").upsert({
    endpoint:cleanSubscription.endpoint,
    subscription,
    updated_at:new Date().toISOString()
  });
  if(q.error)throw q.error;
  return reply({ok:true});
}

async function ensureChatBucket(){
  const existing=await db.storage.getBucket(CHAT_BUCKET);
  if(existing.data)return;
  const created=await db.storage.createBucket(CHAT_BUCKET,{
    public:false,
    fileSizeLimit:"2MB",
    allowedMimeTypes:[...CHAT_IMAGE_TYPES]
  });
  if(created.error){
    const retry=await db.storage.getBucket(CHAT_BUCKET);
    if(!retry.data)throw created.error;
  }
}

async function uploadChatImage(form:FormData){
  const sender=await staffForToken(String(form.get("token")||""));
  if(!sender)return reply({error:"unauthorized"},401);
  const file=form.get("image");
  if(!(file instanceof File))return reply({error:"image_required"},400);
  const type=file.type.toLowerCase();
  if(!CHAT_IMAGE_TYPES.has(type))return reply({error:"image_type"},415);
  if(file.size>CHAT_IMAGE_MAX_BYTES)return reply({error:"image_too_large"},413);
  await ensureChatBucket();
  const ext=type==="image/jpeg"?"jpg":type==="image/png"?"png":"webp";
  const path="chat/"+chatStaffFolder(sender.name)+"/"+crypto.randomUUID()+"."+ext;
  const uploaded=await db.storage.from(CHAT_BUCKET).upload(path,file,{
    contentType:type,
    cacheControl:"3600",
    upsert:false
  });
  if(uploaded.error)throw uploaded.error;
  return reply({ok:true,path,size:file.size});
}

async function signedChatImages(b:any){
  const staff=await staffForToken(String(b.token||""));
  if(!staff)return reply({error:"unauthorized"},401);
  const paths=[...new Set((Array.isArray(b.paths)?b.paths:[]).map((x:any)=>String(x||"")).filter(isChatImagePath))].slice(0,200);
  const images=[];
  for(let i=0;i<paths.length;i+=50){
    const result=await db.storage.from(CHAT_BUCKET).createSignedUrls(paths.slice(i,i+50),3600);
    if(result.error)throw result.error;
    for(const item of result.data||[])if(item.path&&item.signedUrl)images.push({path:item.path,signedUrl:item.signedUrl});
  }
  return reply({ok:true,images});
}

async function deleteChatImage(b:any){
  const staff=await staffForToken(String(b.token||""));
  if(!staff)return reply({error:"unauthorized"},401);
  const path=String(b.path||"");
  if(!isChatImagePath(path))return reply({error:"invalid_path"},400);
  if(staff.role!=="admin"&&!chatImagePathOwnedBy(path,staff.name))return reply({error:"forbidden"},403);
  const removed=await db.storage.from(CHAT_BUCKET).remove([path]);
  if(removed.error)throw removed.error;
  return reply({ok:true});
}

async function sendChat(b:any){
  const sender=await staffForToken(String(b.token||""));
  if(!sender)return reply({error:"unauthorized"},401);
  const imagePath=String(b.imagePath||"").trim();
  const text=String(b.message||"").trim().slice(0,imagePath?900:1000);
  if(/\[\[bixpo-image:/i.test(text))return reply({error:"reserved_marker"},400);
  if(!text&&!imagePath)return reply({error:"empty"},400);
  if(imagePath){
    if(!chatImagePathOwnedBy(imagePath,sender.name))return reply({error:"invalid_image"},400);
    const existing=await db.storage.from(CHAT_BUCKET).info(imagePath);
    if(existing.error||!existing.data)return reply({error:"image_not_found"},400);
  }
  const message=text+(imagePath?(text?"\n":"")+"[[bixpo-image:"+imagePath+"]]":"");
  const inserted=await db.from("bixpo_chat")
    .insert({staff_name:sender.name,message})
    .select("id,staff_name,message,created_at")
    .single();
  if(inserted.error||!inserted.data)throw inserted.error||new Error("chat_insert_failed");

  const push={sent:0,removed:0,excluded:0,failed:0,error:false};
  try{
    const q=await db.from("bixpo_push_subscriptions").select("endpoint,subscription");
    if(q.error)throw q.error;
    const subscriptions=q.data||[];
    const recipients=selectChatPushRecipients(subscriptions,sender.name,String(b.senderEndpoint||""));
    push.excluded=subscriptions.length-recipients.length;
    if(recipients.length){
      const k=await keys();
      webpush.setVapidDetails("mailto:bixpo@kepco.co.kr",k.public_key,k.private_key);
      const payload=JSON.stringify(chatPushPayload(inserted.data));
      for(const row of recipients){
        const {staff_name:_owner,...subscription}=row.subscription||{};
        try{
          await webpush.sendNotification(subscription,payload,{TTL:86400});
          push.sent++;
        }catch(e){
          if(e?.statusCode===404||e?.statusCode===410){
            await db.from("bixpo_push_subscriptions").delete().eq("endpoint",row.endpoint);
            push.removed++;
          }else{
            console.error("chat push delivery",e);
            push.failed++;
          }
        }
      }
    }
  }catch(e){
    console.error("chat push",e);
    push.error=true;
  }
  return reply({ok:true,message:inserted.data,push});
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:H});
  try{
    const contentType=(req.headers.get("content-type")||"").toLowerCase();
    if(contentType.includes("multipart/form-data")){
      const form=await req.formData();
      if(String(form.get("action")||"")==="chat_upload")return await uploadChatImage(form);
      return reply({error:"invalid_action"},400);
    }
    const b=await req.json();
    if(b.action==="key"){
      const k=await keys();
      return reply({publicKey:k.public_key});
    }
    if(b.action==="subscribe")return await saveSubscription(b);
    if(b.action==="chat_send")return await sendChat(b);
    if(b.action==="chat_image_urls")return await signedChatImages(b);
    if(b.action==="chat_image_delete")return await deleteChatImage(b);
    if(b.action==="notify"){
      const expected=Deno.env.get("BIXPO_ADMIN_PASSWORD")||"";
      if(!expected||String(b.password||"")!==expected)return reply({error:"unauthorized"},401);
      const k=await keys();
      webpush.setVapidDetails("mailto:bixpo@kepco.co.kr",k.public_key,k.private_key);
      const q=await db.from("bixpo_push_subscriptions").select("endpoint,subscription");
      if(q.error)throw q.error;
      let sent=0,removed=0;
      const payload=JSON.stringify({
        title:b.title||"안산지사 BIXPO T/F",
        body:b.body||"새 공지사항이 등록되었습니다.",
        url:"/"
      });
      for(const row of q.data||[]){
        try{
          const {staff_name:_owner,...subscription}=row.subscription||{};
          await webpush.sendNotification(subscription,payload,{TTL:86400});
          sent++;
        }catch(e){
          if(e?.statusCode===404||e?.statusCode===410){
            await db.from("bixpo_push_subscriptions").delete().eq("endpoint",row.endpoint);
            removed++;
          }
        }
      }
      return reply({ok:true,sent,removed});
    }
    return reply({error:"invalid_action"},400);
  }catch(e){
    console.error("push",e);
    return reply({error:"push_failed"},500);
  }
});
