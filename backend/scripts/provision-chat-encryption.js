"use strict";

const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const dotenv=require("dotenv");
const {readKeyring}=require("../services/chatEncryption");

const envPath=process.env.DOTENV_CONFIG_PATH||path.join(__dirname,"..",".env");
const current=fs.existsSync(envPath)?dotenv.parse(fs.readFileSync(envPath)):{};
let configuredKeys={};
try{configuredKeys=JSON.parse(String(current.CHAT_DATA_ENCRYPTION_KEYS||"{}"));}catch(_){throw new Error("Existing chat encryption key configuration is invalid.");}
const hasConfiguredKeys=Boolean(current.CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID)&&configuredKeys&&Object.keys(configuredKeys).length>0;
const hasPartialConfiguration=Boolean(current.CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID)&&!hasConfiguredKeys||(!current.CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID&&Object.keys(configuredKeys||{}).length>0);
if(hasPartialConfiguration)throw new Error("Chat encryption key configuration is incomplete; preserve and repair the existing keyring before provisioning another key.");
if(hasConfiguredKeys){
    const ring=readKeyring(current);
    if(!ring.activeKeyId)throw new Error("The chat encryption active key ID is missing.");
    process.stdout.write("Chat encryption keyring is already configured.\n");
    process.exit(0);
}

const keyId="gg-chat-"+new Date().toISOString().slice(0,10).replace(/-/g,"");
const key=crypto.randomBytes(32).toString("base64");
const content=(fs.existsSync(envPath)?"\n":"")+
    "# Application-managed AES-256-GCM keyring for support messages and private evidence.\n"+
    "# Keep this secret in the deployment secret manager and preserve old keys during rotation.\n"+
    "CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID="+keyId+"\n"+
    "CHAT_DATA_ENCRYPTION_KEYS='"+JSON.stringify({[keyId]:key})+"'\n";
fs.appendFileSync(envPath,content,{encoding:"utf8",mode:0o600});
try{fs.chmodSync(envPath,0o600);}catch(_){}
process.stdout.write("A new chat encryption key was added to the backend secret file. The key value was not printed.\n");
