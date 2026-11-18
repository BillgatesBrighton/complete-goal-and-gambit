"use strict";

const path=require("path");
const fs=require("fs");
const dotenv=require("dotenv");
const {Pool}=require("pg");
dotenv.config({path:process.env.DOTENV_CONFIG_PATH||path.join(__dirname,"..",".env")});

const {readKeyring,encryptMessage,LEGACY_PLACEHOLDER}=require("../services/chatEncryption");
const {safeStoragePath,encryptExistingPrivateImage}=require("../services/privateEvidence");

async function migrateMessages(pool){
    let total=0;
    for(;;){
        const client=await pool.connect();
        try{
            await client.query("BEGIN");
            const batch=await client.query(
                `SELECT id,message FROM chat_messages WHERE message_ciphertext IS NULL
                  ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`
            );
            if(!batch.rows.length){await client.query("COMMIT");return total;}
            for(const row of batch.rows){
                const sealed=encryptMessage(row.message);
                await client.query(
                    `UPDATE chat_messages SET message=$1,message_ciphertext=$2,message_iv=$3,message_auth_tag=$4,encryption_key_id=$5
                      WHERE id=$6 AND message_ciphertext IS NULL`,
                    [LEGACY_PLACEHOLDER,sealed.message_ciphertext,sealed.message_iv,sealed.message_auth_tag,sealed.encryption_key_id,row.id]
                );
                total++;
            }
            await client.query("COMMIT");
        }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
        finally{client.release();}
    }
}

async function migrateFiles(pool){
    const results=await pool.query(
        `SELECT storage_key,'complaint' AS kind FROM complaint_evidence
         UNION SELECT screenshot_path,'result' AS kind FROM efootball_result_verifications WHERE screenshot_path IS NOT NULL
         UNION SELECT storage_key,'result' AS kind FROM efootball_result_evidence`
    );
    const complaintDirectory=path.join(__dirname,"..","uploads","complaint-evidence");
    const resultDirectory=path.join(__dirname,"..","uploads","match-verification");
    let encrypted=0,missing=0;
    for(const row of results.rows){
        const directory=row.kind==="complaint"?complaintDirectory:resultDirectory;
        const file=safeStoragePath(directory,row.storage_key);
        if(!file||!fs.existsSync(file)){missing++;continue;}
        if(await encryptExistingPrivateImage(file))encrypted++;
    }
    return {encrypted,missing};
}

async function main(){
    const keyring=readKeyring(process.env);
    if(!keyring.activeKeyId)throw new Error("CHAT_DATA_ENCRYPTION_ACTIVE_KEY_ID is not configured.");
    const databaseUrl=String(process.env.DATABASE_URL||"").trim();
    const config=databaseUrl?{connectionString:databaseUrl}:{
        host:process.env.DB_HOST,port:Number(process.env.DB_PORT)||5432,database:process.env.DB_NAME,
        user:process.env.DB_USER,password:process.env.DB_PASSWORD
    };
    const pool=new Pool({...config,max:4,connectionTimeoutMillis:10000});
    try{
        const messages=await migrateMessages(pool);
        const files=await migrateFiles(pool);
        process.stdout.write("Encrypted "+messages+" legacy messages and "+files.encrypted+" legacy evidence files. Missing evidence files: "+files.missing+".\n");
    }finally{await pool.end();}
}

main().catch((error)=>{process.stderr.write("Chat data migration failed: "+error.message+"\n");process.exitCode=1;});
