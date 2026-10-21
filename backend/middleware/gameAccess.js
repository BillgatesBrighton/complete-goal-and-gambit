"use strict";

// Blocks a route unless the logged-in player picked one of the allowed
// games at sign up ("chess", "konami" or "both").
//   gameAccess(pool, "chess")   -> chess + both
//   gameAccess(pool, "konami")  -> konami + both
module.exports = function gameAccess(pool, needed) {
    return async function (req, res, next) {
        try {
            const r = await pool.query(
                `SELECT u.game,
                        EXISTS (
                            SELECT 1 FROM android_push_tokens t
                             WHERE t.user_id=u.id AND t.active=TRUE
                        ) AS android_companion_registered
                   FROM users u
                  WHERE u.id=$1`,
                [req.user.userId]
            );
            if (!r.rows.length) {
                return res.status(401).json({ success: false, message: "Account not found." });
            }
            const game = r.rows[0].game || "both";
            if (game !== "both" && game !== needed) {
                return res.status(403).json({
                    success: false,
                    message: needed === "chess"
                        ? "Your account is registered for eFootball only."
                        : "Your account is registered for Chess only."
                });
            }

            if (needed === "konami" && !r.rows[0].android_companion_registered) {
                return res.status(403).json({
                    success: false,
                    code: "ANDROID_COMPANION_REQUIRED",
                    downloadUrl: "https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/downloads/goal-gambit-companion.apk?v=1.2.1",
                    message: "Install the Android notification companion, sign in, and enable match alerts and room-code chat replies before using eFootball on the website. Chess remains available for Both accounts."
                });
            }

            return next();
        } catch (e) {
            return res.status(500).json({ success: false, message: "Could not verify game access." });
        }
    };
};
