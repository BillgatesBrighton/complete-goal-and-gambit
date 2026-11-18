"use strict";

const assert = require("node:assert/strict");
const createAccountPresence = require("../services/accountPresence");

let now = 1000;
const presence = createAccountPresence({ now: () => now, ttlMs: 100 });

presence.setWebsitePresence(39, "web-tab-a", true);
assert.equal(presence.isWebsitePresent(39), true);
assert.equal(presence.isWebsitePresent(40), false, "presence is scoped to the authenticated account");
presence.setWebsitePresence(39, "web-tab-b", true);
presence.setWebsitePresence(39, "web-tab-a", false);
assert.equal(presence.isWebsitePresent(39), true, "one hidden tab does not clear another visible tab");
presence.clearSocket("web-tab-b");
assert.equal(presence.isWebsitePresent(39), false);

presence.setChessMatchPresence(39, 700, "board-a", true);
presence.setChessMatchPresence(39, 701, "board-b", true);
assert.equal(presence.isChessMatchVisible(39, 700), true);
assert.equal(presence.isChessMatchVisible(40, 700), false, "match view presence is user scoped");
assert.equal(presence.isChessMatchVisible(39, 702), false, "match view presence is match scoped");
presence.clearSocket("board-a");
assert.equal(presence.isChessMatchVisible(39, 700), false);
assert.equal(presence.isChessMatchVisible(39, 701), true);

presence.setWebsitePresence(40, "stale-tab", true);
now += 101;
assert.equal(presence.isWebsitePresent(40), false, "silent sessions expire after the heartbeat lease");

presence.setApplicationSocket(50, "companion-only", "android-companion", true);
assert.equal(presence.getAdminPresence(50), "unavailable", "a companion socket alone does not claim website presence");
presence.setApplicationSocket(51, "website-session", "website", true);
assert.equal(presence.getAdminPresence(51), "unavailable", "a website connection without observed activity is unavailable");
presence.recordApplicationActivity(51, "website-session");
assert.equal(presence.getAdminPresence(51), "online", "recent website interaction is online");
now += 5 * 60 * 1000 + 1;
assert.equal(presence.getAdminPresence(51), "away", "website interaction older than five minutes is away");
presence.clearSocket("website-session");
assert.equal(presence.getAdminPresence(51), "offline", "disconnected sessions are offline");

console.log("Account presence and five-minute activity tests passed.");
