"use strict";

// Advisory locks use PostgreSQL's two-int key space.  The user id is SERIAL
// (signed int4), so each namespace/account pair is collision-free.  Keep the
// namespaces reserved for this feature and distinct: an operation lease can
// span an async handler while a mutation transaction independently takes its
// own lock without queuing behind an invalidator waiting for that handler.
const ACCOUNT_OPERATION_LOCK_NAMESPACE = 1195724627; // "GGOP"
const ACCOUNT_MUTATION_LOCK_NAMESPACE = 1195724628;  // "GGMU"
const ACCOUNT_LOCK_TIMEOUT = "10s";
// Socket event handlers in this application are short-lived; the engine
// relay itself expires requests at 30 seconds. This PostgreSQL timeout bounds
// an idle lock lease without releasing a transaction-level mutation lock.
const OPERATION_LEASE_IDLE_TIMEOUT = "30s";

function validateAccountId(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
        throw new Error("Cannot synchronize an invalid account id.");
    }
    return id;
}

async function acquireAccountLock(client, userId, scope, mode) {
    if (!client || typeof client.query !== "function") {
        throw new Error("An active transaction client is required for account synchronization.");
    }
    const id = validateAccountId(userId);
    const namespace = scope === "operation"
        ? ACCOUNT_OPERATION_LOCK_NAMESPACE
        : scope === "mutation"
            ? ACCOUNT_MUTATION_LOCK_NAMESPACE
            : 0;
    if (!namespace || !["shared", "exclusive"].includes(mode)) {
        throw new Error("Invalid account synchronization lock scope or mode.");
    }
    await client.query("SET LOCAL lock_timeout = '" + ACCOUNT_LOCK_TIMEOUT + "'");
    const fn = mode === "shared"
        ? "pg_advisory_xact_lock_shared"
        : "pg_advisory_xact_lock";
    await client.query("SELECT " + fn + "($1::integer,$2::integer)", [namespace, id]);
    return id;
}

async function acquireAccountOperationLock(client, userId, mode) {
    return acquireAccountLock(client, userId, "operation", mode || "shared");
}

async function acquireAccountMutationLock(client, userId, mode) {
    return acquireAccountLock(client, userId, "mutation", mode || "shared");
}

async function acquireAccountInvalidationLocks(client, userId) {
    // Never acquire user/session row locks before both gates. The separate
    // operation and mutation namespaces prevent an in-flight handler from
    // blocking on a transaction lock queued behind its own operation lease.
    await acquireAccountOperationLock(client, userId, "exclusive");
    await acquireAccountMutationLock(client, userId, "exclusive");
}

async function isAuthSessionActive(pool, sessionId, userId, authVersion) {
    if (!pool || !sessionId || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) return false;
    const result = await pool.query(
        `SELECT 1 FROM auth_sessions s
          JOIN users u ON u.id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
           AND s.expires_at>NOW() AND u.auth_version=$3`,
        [String(sessionId), Number(userId), Number(authVersion || 0)]
    );
    return result.rows.length > 0;
}

// Call inside the caller's gameplay transaction before taking domain-row
// locks. The shared row lock conflicts with logout's UPDATE of revoked_at and
// remains held until the gameplay transaction commits or rolls back.
async function lockActiveAuthSession(client, user) {
    const sessionId = String(user && user.sessionId || "");
    const userId = Number(user && user.userId);
    if (!client || !sessionId || !Number.isSafeInteger(userId) || userId <= 0) return false;
    await acquireAccountMutationLock(client, userId, "shared");
    const result = await client.query(
        `SELECT 1 FROM auth_sessions s
          JOIN users u ON u.id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
           AND s.expires_at>clock_timestamp() AND u.auth_version=$3
         FOR SHARE OF s`,
        [sessionId, userId, Number(user && user.authVersion || 0)]
    );
    return result.rows.length > 0;
}

// Called after locking the user row FOR UPDATE and inside the same account
// change transaction. Lock every unrevoked session in stable UUID order before
// changing auth_version, then explicitly revoke those old sessions. Including
// expired rows also waits for any event admitted just before token expiry.
async function lockAndRevokeUserSessions(client, userId) {
    const id = validateAccountId(userId);
    const locked = await client.query(
        `SELECT id FROM auth_sessions
          WHERE user_id=$1 AND revoked_at IS NULL
          ORDER BY id
          FOR UPDATE`,
        [id]
    );
    if (!locked.rows.length) return 0;
    const sessionIds = locked.rows.map(row => row.id);
    const revoked = await client.query(
        `UPDATE auth_sessions SET revoked_at=NOW()
          WHERE user_id=$1 AND id=ANY($2::uuid[]) AND revoked_at IS NULL`,
        [id, sessionIds]
    );
    return Number(revoked.rowCount || 0);
}

async function beginAuthSessionLease(pool, user) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '" + OPERATION_LEASE_IDLE_TIMEOUT + "'");
        // This is a long-lived operation lease (not the mutation transaction
        // lock). Do not row-lock auth_sessions here: the route's mutation
        // transaction must acquire its own session lock before its game row.
        await acquireAccountOperationLock(client, user && user.userId, "shared");
        if (!(await isAuthSessionActive(client, user && user.sessionId, user && user.userId, user && user.authVersion))) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            client.release();
            return null;
        }
        let released = false;
        return {
            async release() {
                if (released) return;
                released = true;
                try {
                    await client.query("COMMIT");
                } catch (error) {
                    await client.query("ROLLBACK").catch(() => {});
                    throw error;
                } finally {
                    client.release();
                }
            }
        };
    } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
        client.release();
        throw error;
    }
}

function installSocketSessionGuard(socket, lockPool) {
    socket.data.authSessionRevoked = false;
    const originalOn = socket.on.bind(socket);
    const lifecycleEvents = new Set(["disconnect", "disconnecting", "error"]);

    // Wrap every application event listener. A row-level FOR SHARE lock is
    // held until its async handler settles. Logout's UPDATE conflicts with
    // that lock, so it cannot commit revocation while an admitted operation is
    // still running. New operations then observe the revoked row and fail.
    socket.on = function(eventName, listener) {
        if (lifecycleEvents.has(String(eventName)) || typeof listener !== "function") {
            return originalOn(eventName, listener);
        }
        const guardedListener = async function(...args) {
            if (socket.data.authSessionRevoked) return denySocketOperation(socket, args);
            let client;
            let transactionOpen = false;
            let authorized = false;
            let connectionFailure = null;
            try {
                client = await lockPool.connect();
                // A backend can disappear while the async handler is running.
                // Record the error rather than allowing an unhandled pg Client
                // event; handler-owned mutation transactions have their own
                // account gate and session revalidation.
                client.on("error", error => { connectionFailure = error; });
                await client.query("BEGIN");
                transactionOpen = true;
                await client.query("SET LOCAL idle_in_transaction_session_timeout = '" + OPERATION_LEASE_IDLE_TIMEOUT + "'");
                await acquireAccountOperationLock(client, socket.user && socket.user.userId, "shared");
                const result = await client.query(
                    `SELECT 1 FROM auth_sessions s
                      JOIN users u ON u.id=s.user_id
                     WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
                       AND s.expires_at>NOW() AND u.auth_version=$3
                     FOR SHARE OF s`,
                    [
                        String(socket.user && socket.user.sessionId || ""),
                        Number(socket.user && socket.user.userId),
                        Number(socket.user && socket.user.authVersion || 0)
                    ]
                );
                if (!result.rows.length) {
                    await client.query("ROLLBACK");
                    transactionOpen = false;
                    socket.data.authSessionRevoked = true;
                    return denySocketOperation(socket, args);
                }
                authorized = true;
                const value = await listener.apply(this, args);
                if (connectionFailure) throw connectionFailure;
                await client.query("COMMIT");
                transactionOpen = false;
                return value;
            } catch (error) {
                if (transactionOpen && client) await client.query("ROLLBACK").catch(() => {});
                if (!authorized) {
                    socket.data.authSessionRevoked = true;
                    console.error("Socket session authorization failed:", error && error.message);
                    return denySocketOperation(socket, args);
                }
                console.error("Authenticated socket operation failed:", error && error.message);
                const acknowledgement = args && args.length ? args[args.length - 1] : null;
                if (typeof acknowledgement === "function") {
                    acknowledgement({ success: false, message: "The operation could not be completed." });
                }
                return undefined;
            } finally {
                if (client) client.release(Boolean(connectionFailure));
            }
        };
        return originalOn(eventName, guardedListener);
    };
}

function denySocketOperation(socket, args) {
    const acknowledgement = args && args.length ? args[args.length - 1] : null;
    if (typeof acknowledgement === "function") {
        acknowledgement({ success: false, message: "Authentication session is no longer active." });
    }
    if (!socket.data.authSessionRevoked) socket.data.authSessionRevoked = true;
    socket.disconnect(true);
}

module.exports = {
    ACCOUNT_OPERATION_LOCK_NAMESPACE,
    ACCOUNT_MUTATION_LOCK_NAMESPACE,
    acquireAccountOperationLock,
    acquireAccountMutationLock,
    acquireAccountInvalidationLocks,
    isAuthSessionActive,
    lockActiveAuthSession,
    lockAndRevokeUserSessions,
    beginAuthSessionLease,
    installSocketSessionGuard
};
