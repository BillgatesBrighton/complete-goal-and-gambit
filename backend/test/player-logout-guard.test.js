"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const androidRoot = path.join(__dirname, "..", "..", "android-trial", "app", "src", "main", "java", "com", "goalgambit", "trial");
const activity = fs.readFileSync(path.join(androidRoot, "MainActivity.java"), "utf8");
const sessionStore = fs.readFileSync(path.join(androidRoot, "SessionStore.java"), "utf8");

test("Player App blocks authenticated-screen interaction and never restores a pending logout token", () => {
    const createIndex = activity.indexOf("protected void onCreate");
    const pendingCheck = activity.indexOf("SessionStore.isLogoutPending(this)", createIndex);
    const tokenRead = activity.indexOf("SessionStore.read(this)", createIndex);
    assert.ok(pendingCheck >= 0 && pendingCheck < tokenRead, "pending logout is cleared before session restoration");
    assert.match(sessionStore, /getBoolean\("logout_pending", false\)\) return null/);

    const signOutStart = activity.indexOf("private void signOut()");
    const blockedTouches = activity.indexOf("FLAG_NOT_TOUCHABLE", signOutStart);
    const logoutRequest = activity.indexOf("AuthLogoutCoordinator.run", signOutStart);
    assert.ok(blockedTouches >= 0 && blockedTouches < logoutRequest, "touches are blocked before the network request starts");
    const finishStart = activity.indexOf("private void finishLocalSignOut");
    assert.ok(activity.indexOf("clearFlags(android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)", finishStart) >= 0);
    assert.ok(activity.indexOf("renderAuth();", finishStart) >= 0, "completion leaves the authenticated screen");
});
