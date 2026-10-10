"use strict";

// Blocks a route unless the logged-in player picked one of the allowed
// games at sign up ("chess", "konami" or "both").
//   gameAccess(pool, "chess")   -> chess + both
//   gameAccess(pool, "konami")  -> konami + both
module.exports = function gameAccess(pool, needed) {
    return async function (req, res, next) {
        try {
            const r = await pool.query("SELECT game FROM users WHERE id = $1", [req.user.userId]);
            if (!r.rows.length) {
                return res.status(401).json({ success: false, message: "Account not found." });
            }
            const game = r.rows[0].game || "both";
            if (game === "both" || game === needed) return next();
            return res.status(403).json({
                success: false,
                message: needed === "chess"
                    ? "Your account is registered for Konami eFootball only."
                    : "Your account is registered for Chess only."
            });
        } catch (e) {
            return res.status(500).json({ success: false, message: "Could not verify game access." });
        }
    };
};
