"use strict";

function configuredAdministratorIds(value) {
    const raw = value === undefined ? process.env.ADMIN_USER_IDS : value;
    const parts = String(raw || "").split(",").map(function (item) { return item.trim(); });
    if (parts.length !== 2 || parts.some(function (item) { return !/^[1-9]\d*$/.test(item); })) {
        return new Set();
    }
    const ids = parts.map(Number);
    if (ids.some(function (id) { return !Number.isSafeInteger(id); }) || ids[0] === ids[1]) {
        return new Set();
    }
    return new Set(ids);
}

function isAuthorizedAdministrator(account) {
    if (!account || String(account.role || "").toLowerCase() !== "admin") return false;
    const id = Number(account.id == null ? account.userId : account.id);
    return Number.isSafeInteger(id) && configuredAdministratorIds().has(id);
}

function publicAccountRole(account) {
    const role = String(account && account.role || "user").toLowerCase();
    if (role !== "admin") return role;
    return isAuthorizedAdministrator(account) ? "admin" : "user";
}

function createAdminOnly(pool, label) {
    return async function adminOnly(req, res, next) {
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Pragma", "no-cache");
        try {
            const result = await pool.query(
                "SELECT id, username, role FROM users WHERE id = $1",
                [req.user.userId]
            );
            const account = result.rows[0];
            if (!isAuthorizedAdministrator(account)) {
                return res.status(403).json({ success: false, message: "Administrator access required." });
            }
            req.admin = account;
            return next();
        } catch (error) {
            console.error((label || "Administrator authorization failed") + ":", error.message);
            return res.status(500).json({ success: false, message: "Could not verify administrator access." });
        }
    };
}

module.exports = {
    configuredAdministratorIds,
    isAuthorizedAdministrator,
    publicAccountRole,
    createAdminOnly
};
