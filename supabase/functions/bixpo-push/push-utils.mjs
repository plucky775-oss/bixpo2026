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
    body:message.message||"",
    chat:{
      id:message.id,
      staff_name:message.staff_name,
      message:message.message||""
    },
    url:"/?tab=chat"
  };
}
