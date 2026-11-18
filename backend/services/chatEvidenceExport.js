"use strict";

const crypto = require("crypto");
const path = require("path");
const PDFDocument = require("pdfkit");

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonicalMessages(messages) {
    return JSON.stringify((messages || []).map((message) => ({
        id:Number(message.id), threadId:Number(message.thread_id), senderId:Number(message.sender_id),
        senderUsername:String(message.username || "Unknown sender"), message:String(message.message || ""),
        createdAt:new Date(message.created_at).toISOString(), readAt:message.read_at ? new Date(message.read_at).toISOString() : null,
        clientMessageId:message.client_message_id || null, attachments:Array.isArray(message.attachments) ? message.attachments : []
    })));
}

function buildJsonExport(history) {
    const messages=history.messages||[];
    const canonical=canonicalMessages(messages);
    const payload={
        archiveType:"goal-gambit-support-chat-evidence",
        formatVersion:1,
        exportedAt:new Date().toISOString(),
        exportedBy:{id:Number(history.admin.id),username:String(history.admin.username||"Administrator")},
        player:{id:Number(history.player.id),username:String(history.player.username||"Player")},
        conversations:(history.threads||[]).map((thread)=>({id:Number(thread.id),createdAt:thread.created_at,category:thread.support_category||null,subject:thread.support_subject||null,status:thread.support_status||"open"})),
        messageCount:messages.length,
        messages:JSON.parse(canonical),
        integrity:{algorithm:"SHA-256",messagesSha256:sha256(Buffer.from(canonical,"utf8")),attachments:[]}
    };
    return Buffer.from(JSON.stringify(payload,null,2)+"\n","utf8");
}

function buildPdfExport(history) {
    return new Promise((resolve,reject)=>{
        const doc=new PDFDocument({size:"A4",margin:52,bufferPages:true,info:{Title:"GOAL$GAMBIT Support Chat Evidence",Author:"GOAL$GAMBIT Admin Desk",Subject:"Confidential support conversation evidence"}});
        const chunks=[];
        doc.on("data",(chunk)=>chunks.push(chunk));
        doc.on("error",reject);
        doc.on("end",()=>resolve(Buffer.concat(chunks)));
        const fontPath=path.join(__dirname,"..","assets","fonts","NotoSans.ttf");
        doc.font(fontPath);
        doc.fillColor("#927116").fontSize(10).text("GOAL$GAMBIT  /  ADMIN EVIDENCE",{characterSpacing:1.2});
        doc.moveDown(0.65).fillColor("#171717").fontSize(20).text("Support conversation archive");
        doc.moveDown(0.4).fillColor("#5e6265").fontSize(9)
            .text("CONFIDENTIAL · Read-only investigative export")
            .moveDown(0.8);
        const metadata=[
            ["Player",String(history.player.username||"Player")+" · account #"+Number(history.player.id)],
            ["Exported by",String(history.admin.username||"Administrator")+" · admin #"+Number(history.admin.id)],
            ["Exported at",new Date().toISOString()],
            ["Conversations",String((history.threads||[]).length)],
            ["Messages",String((history.messages||[]).length)]
        ];
        metadata.forEach(([label,value])=>{doc.fillColor("#927116").fontSize(9).text(label.toUpperCase(),{continued:true});doc.fillColor("#171717").fontSize(10).text("   "+value);});
        doc.moveDown(1).strokeColor("#c6a144").moveTo(52,doc.y).lineTo(543,doc.y).stroke();
        const messages=history.messages||[];
        if(!messages.length){doc.moveDown(1).fillColor("#5e6265").fontSize(11).text("No support messages were present in this archive.");}
        for(const message of messages){
            const sender=String(message.username||"Unknown sender");
            const stamp=message.created_at?new Date(message.created_at).toISOString():"Timestamp unavailable";
            doc.moveDown(0.7);
            if(doc.y>720)doc.addPage();
            doc.fillColor("#927116").fontSize(9).text(sender+"   ·   "+stamp);
            doc.moveDown(0.15).fillColor("#171717").fontSize(10).text(String(message.message||""),{width:490,paragraphGap:4});
            doc.fillColor("#74797c").fontSize(8).text("Message ID "+Number(message.id)+"  ·  Thread "+Number(message.thread_id)+(message.client_message_id?"  ·  Client ref "+String(message.client_message_id):""));
            if(message.read_at)doc.fillColor("#74797c").fontSize(8).text("Read receipt recorded: "+new Date(message.read_at).toISOString());
            doc.moveDown(0.2).strokeColor("#e2e4e5").moveTo(52,doc.y).lineTo(543,doc.y).stroke();
        }
        const range=doc.bufferedPageRange();
        for(let page=range.start;page<range.start+range.count;page++){
            doc.switchToPage(page);
            doc.save().fillColor("#777").fontSize(8).text("GOAL$GAMBIT · CONFIDENTIAL · SHA-256 manifest recorded in administrator audit",52,770,{width:490,align:"center"}).restore();
            doc.fillColor("#777").fontSize(8).text(String(page+1)+" / "+range.count,520,770,{width:24,align:"right"});
        }
        doc.end();
    });
}

module.exports={sha256,buildJsonExport,buildPdfExport};
