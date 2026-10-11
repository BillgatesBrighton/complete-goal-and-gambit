 "use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { getImageType, safeStoragePath, storePrivateImage } = require("../services/privateEvidence");
const router = express.Router();

module.exports = function(pool, authenticateToken, getOnlineUserIds) {
    const complaintEvidenceDirectory = path.join(__dirname, "..", "uploads", "complaint-evidence");
    const complaintUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 8 * 1024 * 1024, files: 1 },
        fileFilter: function(req, file, callback) {
            const allowed = ["image/jpeg", "image/png", "image/webp"];
            callback(allowed.includes(file.mimetype) ? null : new Error("Use a JPEG, PNG or WebP image."), allowed.includes(file.mimetype));
        }
    }).single("evidence");

    function receiveComplaintEvidence(req, res, next) {
        complaintUpload(req, res, function(error) {
            if (!error) return next();
            const tooLarge = error.code === "LIMIT_FILE_SIZE";
            return res.status(tooLarge ? 413 : 400).json({ success: false, message: tooLarge ? "Evidence must be 8 MB or smaller." : error.message });
        });
    }
    function isOnline(id) {
        return typeof getOnlineUserIds === "function" &&
            getOnlineUserIds().some(function(onlineId) { return Number(onlineId) === Number(id); });
    }

    async function activeUser(id) {
        const r = await pool.query(
            `SELECT id,username,role,account_status FROM users WHERE id=$1`,
            [id]
        );
        return r.rows[0] || null;
    }

    // Support threads use user_two_id=NULL. PostgreSQL UNIQUE constraints do
    // not treat NULL values as equal, so support threads must be found/created
    // explicitly instead of relying on ON CONFLICT.
    async function getOrCreateSupportThread(userId) {
        const created = await pool.query(
            `INSERT INTO chat_threads(thread_type,user_one_id,user_two_id)
             VALUES('support',$1,NULL)
             ON CONFLICT (user_one_id)
             WHERE thread_type='support' AND user_two_id IS NULL
             DO NOTHING
             RETURNING id`,
            [userId]
        );

        if (created.rows.length) return created.rows[0].id;

        const existing = await pool.query(
            `SELECT id FROM chat_threads
             WHERE thread_type='support' AND user_one_id=$1 AND user_two_id IS NULL
             ORDER BY id ASC LIMIT 1`,
            [userId]
        );

        if (!existing.rows.length) {
            throw new Error("Unable to create support conversation.");
        }

        return existing.rows[0].id;
    }

    // =========================================================
    // PRIVATE INBOX
    // =========================================================
    router.get("/inbox", authenticateToken, async (req,res) => {
        const me = Number(req.user.userId);
        try {
            const r = await pool.query(
                `SELECT t.id AS thread_id,
                        u.id AS user_id,
                        u.username,
                        u.game,
                        lm.message AS last_message,
                        lm.created_at AS last_message_at,
                        lm.read_at AS last_message_read_at,
                        COALESCE(un.unread_count,0)::int AS unread_count
                 FROM chat_threads t
                 JOIN users u ON u.id = CASE WHEN t.user_one_id=$1 THEN t.user_two_id ELSE t.user_one_id END
                 LEFT JOIN LATERAL (
                     SELECT m.message,m.created_at,m.read_at
                     FROM chat_messages m
                     WHERE m.thread_id=t.id
                     ORDER BY m.created_at DESC,m.id DESC
                     LIMIT 1
                 ) lm ON TRUE
                 LEFT JOIN LATERAL (
                     SELECT COUNT(*) AS unread_count
                     FROM chat_messages m
                     WHERE m.thread_id=t.id AND m.sender_id<>$1 AND m.read_at IS NULL
                 ) un ON TRUE
                 WHERE t.thread_type='direct'
                   AND (t.user_one_id=$1 OR t.user_two_id=$1)
                   AND u.account_status='active'
                 ORDER BY COALESCE(lm.created_at,t.created_at) DESC,t.id DESC
                 LIMIT 100`,
                [me]
            );
            const unread = r.rows.reduce((sum,row)=>sum+Number(row.unread_count||0),0);
            const threads = r.rows.map(function(row) {
                return Object.assign({}, row, { online: isOnline(row.user_id) });
            });
            res.json({success:true,threads:threads,unreadCount:unread});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load chat inbox."});
        }
    });

    router.get("/notifications", authenticateToken, async (req,res) => {
        const me = Number(req.user.userId);
        try {
            const r = await pool.query(
                `SELECT m.id,m.thread_id,m.sender_id,m.message,m.created_at,u.username
                 FROM chat_messages m
                 JOIN chat_threads t ON t.id=m.thread_id AND t.thread_type='direct'
                 JOIN users u ON u.id=m.sender_id
                 WHERE m.sender_id<>$1
                   AND m.read_at IS NULL
                   AND (t.user_one_id=$1 OR t.user_two_id=$1)
                 ORDER BY m.created_at DESC,m.id DESC
                 LIMIT 50`,
                [me]
            );
            res.json({success:true,notifications:r.rows,unreadCount:r.rows.length});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load notifications."});
        }
    });

    router.get("/users", authenticateToken, async (req,res) => {
        const q = String(req.query.search || "").trim().toLowerCase();
        if (!q) return res.json({success:true,users:[]});
        try {
            const r = await pool.query(
                `SELECT id,username,game FROM users
                 WHERE account_status='active' AND id<>$1
                   AND LOWER(username) LIKE '%' || $2 || '%'
                 ORDER BY username LIMIT 30`,
                [req.user.userId,q]
            );
            res.json({success:true,users:r.rows.map(function(user) {
                return Object.assign({}, user, { online: isOnline(user.id) });
            })});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not search users."});
        }
    });

    router.get("/online", authenticateToken, async (req,res) => {
        const me = Number(req.user.userId);
        const ids = typeof getOnlineUserIds === "function"
            ? getOnlineUserIds().map(Number).filter(function(id) { return Number.isSafeInteger(id) && id > 0 && id !== me; })
            : [];
        if (!ids.length) return res.json({success:true,users:[]});
        try {
            const r = await pool.query(
                `SELECT id,username,game FROM users
                 WHERE account_status='active' AND id=ANY($1::int[])
                 ORDER BY username LIMIT 100`,
                [ids]
            );
            res.json({success:true,users:r.rows.map(function(user) {
                return Object.assign({}, user, { online: true });
            })});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load online players."});
        }
    });

    router.get("/direct/:userId", authenticateToken, async (req,res) => {
        const other=Number(req.params.userId), me=Number(req.user.userId);
        if(!Number.isInteger(other)||other<=0||other===me)
            return res.status(400).json({success:false,message:"Invalid chat user."});
        try {
            const target=await activeUser(other);
            if(!target||target.account_status!=="active")
                return res.status(404).json({success:false,message:"That user is not available for chat."});
            const low=Math.min(me,other), high=Math.max(me,other);
            const t=await pool.query(
                `INSERT INTO chat_threads(thread_type,user_one_id,user_two_id)
                 VALUES('direct',$1,$2)
                 ON CONFLICT(thread_type,user_one_id,user_two_id)
                 DO UPDATE SET user_one_id=EXCLUDED.user_one_id
                 RETURNING id`,[low,high]);
            await pool.query(
                `UPDATE chat_messages SET read_at=NOW()
                 WHERE thread_id=$1 AND sender_id=$2 AND read_at IS NULL`,
                [t.rows[0].id,other]
            );
            const messages=await pool.query(
                `SELECT m.id,m.sender_id,m.message,m.created_at,m.read_at,u.username
                 FROM chat_messages m JOIN users u ON u.id=m.sender_id
                 WHERE m.thread_id=$1 ORDER BY m.created_at ASC LIMIT 500`,[t.rows[0].id]);
            res.json({success:true,threadId:t.rows[0].id,other:Object.assign({},target,{online:isOnline(target.id)}),messages:messages.rows});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load conversation."});
        }
    });

    router.post("/direct/:userId", authenticateToken, async (req,res) => {
        const other=Number(req.params.userId), me=Number(req.user.userId);
        const message=String(req.body.message||"").trim();
        if(!Number.isInteger(other)||other<=0||other===me)
            return res.status(400).json({success:false,message:"Invalid chat user."});
        if(!message||message.length>2000)
            return res.status(400).json({success:false,message:"Message must be 1-2000 characters."});
        try {
            const target=await activeUser(other);
            if(!target||target.account_status!=="active")
                return res.status(404).json({success:false,message:"That user is not available for chat."});
            const low=Math.min(me,other),high=Math.max(me,other);
            const t=await pool.query(
                `INSERT INTO chat_threads(thread_type,user_one_id,user_two_id)
                 VALUES('direct',$1,$2)
                 ON CONFLICT(thread_type,user_one_id,user_two_id)
                 DO UPDATE SET user_one_id=EXCLUDED.user_one_id
                 RETURNING id`,[low,high]);
            const m=await pool.query(
                `INSERT INTO chat_messages(thread_id,sender_id,message)
                 VALUES($1,$2,$3)
                 RETURNING id,sender_id,message,created_at,read_at`,[t.rows[0].id,me,message]);
            await pool.query(`UPDATE chat_threads SET admin_cleared_at=NULL WHERE id=$1`,[t.rows[0].id]);

            await pool.query(
                `INSERT INTO system_notifications(user_id,type,title,message)
                 VALUES($1,'chat_message',$2,$3)`,
                [target.id, `New message from ${req.user.username}`, message]
            );

            res.json({success:true,message:m.rows[0],recipient:{id:target.id,username:target.username}});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not send message."});
        }
    });

    // =========================================================
    // SUPPORT / CHAT WITH ADMIN
    // =========================================================
    router.get("/support", authenticateToken, async (req,res) => {
        const me=Number(req.user.userId);
        try {
            const threadId = await getOrCreateSupportThread(me);
            await pool.query(
                `UPDATE chat_messages SET read_at=NOW()
                 WHERE thread_id=$1 AND sender_id<>$2 AND read_at IS NULL`,
                [threadId,me]
            );
            const messages=await pool.query(
                `SELECT m.id,m.sender_id,m.message,m.created_at,m.read_at,u.username
                 FROM chat_messages m JOIN users u ON u.id=m.sender_id
                 WHERE m.thread_id=$1 ORDER BY m.created_at ASC LIMIT 500`,[threadId]);
            res.json({success:true,threadId,messages:messages.rows});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load support chat."});
        }
    });

    router.post("/support", authenticateToken, async (req,res) => {
        const me=Number(req.user.userId), message=String(req.body.message||"").trim();
        if(!message||message.length>2000)
            return res.status(400).json({success:false,message:"Message must be 1-2000 characters."});
        try {
            const threadId = await getOrCreateSupportThread(me);
            const m=await pool.query(
                `INSERT INTO chat_messages(thread_id,sender_id,message)
                 VALUES($1,$2,$3)
                 RETURNING id,sender_id,message,created_at,read_at`,[threadId,me,message]);
            await pool.query(`UPDATE chat_threads SET admin_cleared_at=NULL WHERE id=$1`,[threadId]);

            const admins = await pool.query(
                `SELECT id FROM users WHERE role='admin' AND account_status='active'`
            );
            for (const admin of admins.rows) {
                await pool.query(
                    `INSERT INTO system_notifications(user_id,type,title,message)
                     VALUES($1,'support_message',$2,$3)`,
                    [admin.id, `Support message from ${req.user.username}`, message]
                );
            }

            res.json({success:true,message:m.rows[0]});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not send support message."});
        }
    });

    // =========================================================
    // GENERAL CHAT
    // =========================================================
    router.get("/general", authenticateToken, async (req,res) => {
        const limit=Math.min(Math.max(Number(req.query.limit)||100,1),200);
        try {
            const r=await pool.query(
                `SELECT g.id,g.sender_id,g.message,g.created_at,u.username
                 FROM general_chat_messages g
                 JOIN users u ON u.id=g.sender_id
                 WHERE u.account_status='active'
                 ORDER BY g.created_at DESC,g.id DESC
                 LIMIT $1`,[limit]
            );
            res.json({success:true,messages:r.rows.reverse()});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load General Chat."});
        }
    });

    router.post("/general", authenticateToken, async (req,res) => {
        const me=Number(req.user.userId);
        const message=String(req.body.message||"").trim();
        if(!message||message.length>2000)
            return res.status(400).json({success:false,message:"Message must be 1-2000 characters."});
        try {
            const u=await activeUser(me);
            if(!u||u.account_status!=="active")
                return res.status(403).json({success:false,message:"Your account cannot use chat."});
            const r=await pool.query(
                `INSERT INTO general_chat_messages(sender_id,message)
                 VALUES($1,$2)
                 RETURNING id,sender_id,message,created_at`,[me,message]);
            res.status(201).json({success:true,message:r.rows[0],username:u.username});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not send General Chat message."});
        }
    });

    // =========================================================
    // ADMIN ANNOUNCEMENTS
    // =========================================================
    router.get("/announcements", authenticateToken, async (req,res) => {
        const me=Number(req.user.userId);
        try {
            const r=await pool.query(
                `SELECT a.id,a.message,a.created_at,a.admin_id,
                        u.username AS admin_username,
                        CASE WHEN ar.user_id IS NULL THEN FALSE ELSE TRUE END AS is_read
                 FROM admin_announcements a
                 JOIN users u ON u.id=a.admin_id
                 LEFT JOIN admin_announcement_reads ar
                   ON ar.announcement_id=a.id AND ar.user_id=$1
                 WHERE a.active=TRUE
                 ORDER BY a.created_at DESC,a.id DESC
                 LIMIT 50`,[me]);
            const unread=r.rows.filter(x=>!x.is_read).length;
            res.json({success:true,announcements:r.rows,unreadCount:unread});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not load announcements."});
        }
    });

    router.post("/announcements/:id/read", authenticateToken, async (req,res) => {
        const id=Number(req.params.id), me=Number(req.user.userId);
        if(!Number.isInteger(id)||id<=0)
            return res.status(400).json({success:false,message:"Invalid announcement."});
        try {
            const exists=await pool.query(
                `SELECT id FROM admin_announcements WHERE id=$1 AND active=TRUE`,[id]);
            if(!exists.rows.length)
                return res.status(404).json({success:false,message:"Announcement not found."});
            await pool.query(
                `INSERT INTO admin_announcement_reads(announcement_id,user_id)
                 VALUES($1,$2)
                 ON CONFLICT(announcement_id,user_id)
                 DO UPDATE SET read_at=NOW()`,[id,me]);
            res.json({success:true});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not mark announcement as read."});
        }
    });

    router.post("/announcements/read-all", authenticateToken, async (req,res) => {
        const me=Number(req.user.userId);
        try {
            await pool.query(
                `INSERT INTO admin_announcement_reads(announcement_id,user_id)
                 SELECT a.id,$1 FROM admin_announcements a
                 WHERE a.active=TRUE
                 ON CONFLICT(announcement_id,user_id)
                 DO UPDATE SET read_at=NOW()`,[me]);
            res.json({success:true});
        } catch(e) {
            console.error(e);
            res.status(500).json({success:false,message:"Could not mark announcements as read."});
        }
    });

    // =========================================================
    // PLAYER COMPLAINTS AND PRIVATE EVIDENCE
    // =========================================================
    router.get("/complaints", authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT c.id,c.complaint_ref,c.match_id,c.category,c.subject,c.description,c.status,c.priority,
                        c.resolution_reason,c.created_at,c.updated_at,c.resolved_at,
                        m.status AS match_status,m.mode AS match_mode,m.league AS league_name,
                        (SELECT COUNT(*)::int FROM complaint_evidence e WHERE e.complaint_id=c.id) AS evidence_count
                   FROM complaints c LEFT JOIN efootball_matches m ON m.id=c.match_id
                  WHERE c.reporter_id=$1 ORDER BY c.updated_at DESC,c.id DESC LIMIT 100`,
                [req.user.userId]
            );
            return res.json({ success: true, complaints: result.rows });
        } catch (error) {
            console.error("Player complaint list failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not load your complaints." });
        }
    });

    router.post("/complaint", authenticateToken, receiveComplaintEvidence, async (req, res) => {
        const reporterId = Number(req.user.userId);
        const reportedUsername = String(req.body.reportedUsername || "").trim().toLowerCase();
        const requestedCategory = String(req.body.category || "other").trim().toLowerCase();
        const allowedCategories = new Set(["match-dispute", "wrong-result", "room-code", "player-behaviour", "payments", "account", "player-support", "other"]);
        const category = allowedCategories.has(requestedCategory) ? requestedCategory : "other";
        const subject = String(req.body.subject || "").trim().slice(0, 160);
        const description = String(req.body.description || "").trim().slice(0, 4000);
        const rawMatchId = String(req.body.matchId || "").trim();
        const matchId = rawMatchId ? Number(rawMatchId) : null;
        if (!subject || !description) return res.status(400).json({ success: false, message: "Subject and description are required." });
        if (rawMatchId && (!Number.isSafeInteger(matchId) || matchId <= 0)) return res.status(400).json({ success: false, message: "Enter a valid match ID." });

        let stored = null;
        try {
            let reportedId = null;
            let verificationId = null;
            if (matchId) {
                const match = await pool.query(
                    `SELECT m.id,m.creator_id,m.opponent_id,creator.username AS creator_username,
                            opponent.username AS opponent_username,v.id AS verification_id
                       FROM efootball_matches m
                       JOIN users creator ON creator.id=m.creator_id
                       LEFT JOIN users opponent ON opponent.id=m.opponent_id
                       LEFT JOIN efootball_result_verifications v ON v.match_id=m.id
                      WHERE m.id=$1`, [matchId]
                );
                if (!match.rows.length) return res.status(404).json({ success: false, message: "That match could not be found." });
                const m = match.rows[0];
                if (![Number(m.creator_id), Number(m.opponent_id)].includes(reporterId)) {
                    return res.status(403).json({ success: false, message: "You can only report a match you participated in." });
                }
                reportedId = Number(m.creator_id) === reporterId ? m.opponent_id : m.creator_id;
                verificationId = m.verification_id || null;
                if (reportedUsername && reportedId) {
                    const expected = Number(m.creator_id) === reporterId ? String(m.opponent_username || "").toLowerCase() : String(m.creator_username || "").toLowerCase();
                    if (reportedUsername !== expected) return res.status(400).json({ success: false, message: "The reported player must be the other participant in this match." });
                }
            } else if (reportedUsername) {
                const user = await pool.query("SELECT id FROM users WHERE LOWER(username)=$1", [reportedUsername]);
                if (!user.rows.length) return res.status(404).json({ success: false, message: "Reported username was not found." });
                reportedId = Number(user.rows[0].id);
                if (reportedId === reporterId) return res.status(400).json({ success: false, message: "You cannot report your own account." });
            }

            const volume = await pool.query(
                `SELECT COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '1 hour')::int AS recent,
                        COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '5 minutes' AND match_id IS NOT DISTINCT FROM $2 AND LOWER(subject)=LOWER($3) AND description=$4)::int AS duplicate
                   FROM complaints WHERE reporter_id=$1`, [reporterId, matchId, subject, description]
            );
            if (Number(volume.rows[0].recent) >= 5) return res.status(429).json({ success: false, message: "Please wait before submitting another complaint. You can add follow-up evidence to an existing case." });
            if (Number(volume.rows[0].duplicate) > 0) return res.status(409).json({ success: false, message: "This complaint was just submitted. Use its reference to add follow-up evidence." });

            let imageType = null;
            if (req.file) {
                imageType = getImageType(req.file.buffer, req.file.mimetype);
                if (!imageType) return res.status(400).json({ success: false, message: "The uploaded file is not a valid JPEG, PNG or WebP image." });
                stored = await storePrivateImage(complaintEvidenceDirectory, req.file.buffer, imageType);
            }
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const inserted = await client.query(
                    `INSERT INTO complaints
                        (complaint_ref,reporter_id,reported_user_id,match_id,category,subject,description,status,priority,source)
                     VALUES($1,$2,$3,$4,$5,$6,$7,'open','normal',$8)
                     RETURNING id,complaint_ref,match_id,status,created_at`,
                    ["GG-" + require("crypto").randomUUID(), reporterId, reportedId, matchId, category, subject, description, matchId ? "match_dispute" : "support"]
                );
                const complaint = inserted.rows[0];
                if (stored) {
                    await client.query(
                        `INSERT INTO complaint_evidence(complaint_id,match_id,verification_id,uploader_id,storage_key,mime_type,byte_size,purpose)
                         VALUES($1,$2,$3,$4,$5,$6,$7,'initial_complaint')`,
                        [complaint.id, matchId, verificationId, reporterId, stored.storageKey, stored.mimeType, stored.byteSize]
                    );
                }
                await client.query(
                    `INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,to_status,message,metadata)
                     VALUES($1,$2,'player','submitted','open','Complaint submitted by player',$3::jsonb)`,
                    [complaint.id, reporterId, JSON.stringify({ matchId, evidenceAttached: !!stored })]
                );
                await client.query("COMMIT");
                return res.status(201).json({ success: true, message: "Complaint submitted.", complaint: { ...complaint, evidenceAttached: !!stored } });
            } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                if (stored) await fs.promises.unlink(stored.path).catch(() => {});
                throw error;
            } finally { client.release(); }
        } catch (error) {
            if (stored) await fs.promises.unlink(stored.path).catch(() => {});
            console.error("Player complaint submission failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not submit complaint." });
        }
    });

    router.post("/complaints/:id/evidence", authenticateToken, receiveComplaintEvidence, async (req, res) => {
        const caseId = Number(req.params.id);
        const userId = Number(req.user.userId);
        if (!Number.isSafeInteger(caseId) || caseId <= 0 || !req.file) return res.status(400).json({ success: false, message: "Choose an image to add to this complaint." });
        const imageType = getImageType(req.file.buffer, req.file.mimetype);
        if (!imageType) return res.status(400).json({ success: false, message: "The uploaded file is not a valid JPEG, PNG or WebP image." });
        let stored = null;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const caseResult = await client.query(
                `SELECT c.id,c.reporter_id,c.reported_user_id,c.status,c.match_id,m.creator_id,m.opponent_id
                   FROM complaints c LEFT JOIN efootball_matches m ON m.id=c.match_id
                  WHERE c.id=$1 FOR UPDATE OF c`, [caseId]
            );
            if (!caseResult.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Complaint not found." }); }
            const record = caseResult.rows[0];
            const participantIds = [record.reporter_id, record.reported_user_id, record.creator_id, record.opponent_id].filter(Boolean).map(Number);
            if (!participantIds.includes(userId)) { await client.query("ROLLBACK"); return res.status(403).json({ success: false, message: "You are not allowed to add evidence to this complaint." }); }
            if (["resolved", "dismissed"].includes(record.status)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "This complaint is closed. Contact support to request a follow-up." }); }
            stored = await storePrivateImage(complaintEvidenceDirectory, req.file.buffer, imageType);
            const pending = await client.query(
                `SELECT id FROM complaint_evidence_requests WHERE complaint_id=$1 AND target_user_id=$2 AND status='pending'
                  ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [caseId, userId]
            );
            const requestId = pending.rows[0] ? pending.rows[0].id : null;
            const inserted = await client.query(
                `INSERT INTO complaint_evidence(complaint_id,match_id,verification_id,request_id,uploader_id,storage_key,mime_type,byte_size,purpose)
                 VALUES($1,$2,(SELECT id FROM efootball_result_verifications WHERE match_id=$2),$3,$4,$5,$6,$7,'follow_up')
                 RETURNING id,created_at`,
                [caseId, record.match_id, requestId, userId, stored.storageKey, stored.mimeType, stored.byteSize]
            );
            if (requestId) await client.query("UPDATE complaint_evidence_requests SET status='fulfilled',fulfilled_at=NOW() WHERE id=$1", [requestId]);
            const nextStatus = record.status === "awaiting_evidence" ? "investigating" : record.status;
            await client.query("UPDATE complaints SET status=$1,updated_at=NOW() WHERE id=$2", [nextStatus, caseId]);
            await client.query(
                `INSERT INTO complaint_case_events(complaint_id,actor_id,actor_role,event_type,from_status,to_status,message,metadata)
                 VALUES($1,$2,'player','evidence_uploaded',$3,$4,'Player added private case evidence',$5::jsonb)`,
                [caseId, userId, record.status, nextStatus, JSON.stringify({ evidenceId: Number(inserted.rows[0].id), requestId: requestId ? Number(requestId) : null })]
            );
            await client.query("COMMIT");
            return res.status(201).json({ success: true, evidence: inserted.rows[0] });
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (stored) await fs.promises.unlink(stored.path).catch(() => {});
            console.error("Player complaint evidence upload failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not add evidence." });
        } finally { client.release(); }
    });

    router.get("/complaints/:id/evidence/:evidenceId", authenticateToken, async (req, res) => {
        const caseId = Number(req.params.id), evidenceId = Number(req.params.evidenceId), userId = Number(req.user.userId);
        if (!Number.isSafeInteger(caseId) || caseId <= 0 || !Number.isSafeInteger(evidenceId) || evidenceId <= 0) return res.status(400).json({ success: false, message: "Invalid evidence reference." });
        try {
            const result = await pool.query(
                `SELECT e.storage_key,e.mime_type,c.reporter_id,c.reported_user_id,m.creator_id,m.opponent_id
                   FROM complaint_evidence e JOIN complaints c ON c.id=e.complaint_id
                   LEFT JOIN efootball_matches m ON m.id=e.match_id
                  WHERE e.complaint_id=$1 AND e.id=$2`, [caseId, evidenceId]
            );
            if (!result.rows.length) return res.status(404).json({ success: false, message: "Evidence not found." });
            const record = result.rows[0];
            if (![record.reporter_id, record.reported_user_id, record.creator_id, record.opponent_id].filter(Boolean).map(Number).includes(userId)) return res.status(403).json({ success: false, message: "You are not allowed to view this evidence." });
            const file = safeStoragePath(complaintEvidenceDirectory, record.storage_key);
            if (!file || !fs.existsSync(file)) return res.status(404).json({ success: false, message: "Evidence file is missing." });
            res.setHeader("Content-Type", record.mime_type);
            res.setHeader("Content-Disposition", "inline");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "private, no-store");
            return res.sendFile(file);
        } catch (error) {
            console.error("Player complaint evidence read failed:", error.message);
            return res.status(500).json({ success: false, message: "Could not open evidence." });
        }
    });

    return router;
};
