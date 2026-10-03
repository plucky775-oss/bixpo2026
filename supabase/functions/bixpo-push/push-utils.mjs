export function isChatImagePath(value){
  return /^chat\/[^/]{1,180}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i.test(String(value||""));
}

export function chatImagePathOwnedBy(path,staffName){
  return isChatImagePath(path)&&String(path).split("/")[1]===encodeURIComponent(String(staffName||""));
}

export function chatMessageImagePath(message){
  const match=String(message||"").match(/\n?\[\[bixpo-image:(chat\/[^\r\n\]]+)\]\]$/);
  return match&&isChatImagePath(match[1])?match[1]:"";
}

export function chatMessageParts(message){
  const raw=String(message||"");
  const match=raw.match(/\n?\[\[bixpo-image:(chat\/[^\r\n\]]+)\]\]$/);
  const imagePath=match&&isChatImagePath(match[1])?match[1]:"";
  return imagePath?{text:raw.slice(0,match.index).trim(),imagePath}:{text:raw.trim(),imagePath:""};
}

export function chatMessageNotificationBody(message){
  const parts=chatMessageParts(message);
  return parts.imagePath?(parts.text?parts.text+" · 📷 사진":"📷 사진"):parts.text;
}

export function selectChatPushRecipients(rows,senderName,senderEndpoint){
  return (rows||[]).filter(row=>
    row.endpoint!==senderEndpoint&&row.subscription?.staff_name!==senderName
  );
}

export function chatPushPayload(message){
  return {
    type:"chat",
    id:message.id,
    title:message.staff_name+" · 새 채팅",
    body:chatMessageNotificationBody(message.message||""),
    chat:{
      id:message.id,
      staff_name:message.staff_name,
      message:message.message||""
    },
    url:"/?tab=chat"
  };
}
