"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const API_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "js", "api.js"), "utf8");

function loadWebsiteApi(fetchImpl, localValues, navigatorObject) {
    localValues = localValues || new Map([["goalGambitToken", "test-bearer-token"], ["goalGambitLoggedIn", "true"]]);
    const sessionValues = new Map();
    const location = {
        hostname: "example.test", protocol: "https:", port: "443", origin: "https://example.test",
        href: "https://example.test/pages/dashboard.html", pathname: "/pages/dashboard.html", search: "", hash: "",
        replace(url) { this.href = String(url); }
    };
    const storage = (map) => ({
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); }
    });
    const document = {
        currentScript: { src: "https://example.test/frontend/js/api.js" },
        readyState: "loading", body: null,
        addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
        createElement() { return { remove() {} }; }, head: { appendChild() {} }
    };
    const window = {
        GG_API_BASE: "https://api.example.test",
        addEventListener() {}, dispatchEvent() {}, setInterval() { return 1; }, clearInterval() {},
        setTimeout(callback, delay) { return setTimeout(callback, delay === 8000 ? 10 : delay); },
        clearTimeout(id) { clearTimeout(id); }
    };
    const context = {
        window, document, location, navigator: navigatorObject || {}, localStorage: storage(localValues),
        sessionStorage: storage(sessionValues), fetch: fetchImpl, URL, URLSearchParams,
        AbortController, CustomEvent: function(name, options) { this.type = name; this.detail = options && options.detail; },
        FormData, Set, Map, Array, Date, Math, JSON, Promise, console
    };
    vm.runInNewContext(API_SOURCE, context, { filename: "frontend/js/api.js" });
    return { GG: window.GG, location, localValues };
}

function waitFor(predicate, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for website logout."));
            setTimeout(poll, 2);
        };
        poll();
    });
}

test("website logout reports confirmed server revocation and clears its bearer token", async () => {
    let authorization = "";
    const app = loadWebsiteApi(async (_url, options) => {
        authorization = options.headers.Authorization;
        return { ok: true, status: 200, json: async () => ({ success: true, revoked: true }) };
    });
    app.GG.logout();
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(authorization, "Bearer test-bearer-token");
    assert.equal(app.location.href, "https://example.test/frontend/pages/index.html");
    assert.equal(app.localValues.has("goalGambitToken"), false);
});

test("a stalled website logout is aborted and ends in local-only sign-out", async () => {
    let requestSignal;
    const app = loadWebsiteApi((_url, options) => new Promise((_resolve, reject) => {
        requestSignal = options.signal;
        requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    app.GG.logout();
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(requestSignal.aborted, true);
    assert.equal(app.location.href, "https://example.test/frontend/pages/index.html");
    assert.equal(app.localValues.has("goalGambitToken"), false);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function signInOtherTab(sharedValues) {
    const otherTab = loadWebsiteApi(async () => ({ ok: true, status: 200, json: async () => ({}) }), sharedValues);
    otherTab.GG.saveSession("new-tab-session-token", { id: 42, username: "player-b", game: "both", rating: 1200 });
    return otherTab;
}

test("late successful logout keeps a newer cross-tab login and uses the captured old token", async () => {
    const response = deferred();
    const requestStarted = deferred();
    const sharedValues = new Map([["goalGambitToken", "old-tab-session-token"], ["goalGambitLoggedIn", "true"]]);
    let authorization;
    const app = loadWebsiteApi((_url, options) => {
        authorization = options.headers.Authorization;
        requestStarted.resolve();
        return response.promise;
    }, sharedValues);
    app.GG.logout();
    await requestStarted.promise;
    signInOtherTab(sharedValues);
    response.resolve({ ok: true, status: 200, json: async () => ({ success: true, revoked: true }) });
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(authorization, "Bearer old-tab-session-token");
    assert.equal(sharedValues.get("goalGambitToken"), "new-tab-session-token");
    assert.equal(sharedValues.get("goalGambitUsername"), "player-b");
});

test("logout sends its captured token if another tab signs in before the request starts", async () => {
    const registration = deferred();
    const disableStarted = deferred();
    const requestStarted = deferred();
    const response = deferred();
    const sharedValues = new Map([["goalGambitToken", "old-tab-session-token"], ["goalGambitLoggedIn", "true"]]);
    let authorization;
    const app = loadWebsiteApi((_url, options) => {
        authorization = options.headers.Authorization;
        requestStarted.resolve();
        return response.promise;
    }, sharedValues, { serviceWorker: { getRegistration() { disableStarted.resolve(); return registration.promise; } } });
    app.GG.logout();
    await disableStarted.promise;
    signInOtherTab(sharedValues);
    registration.resolve(null);
    await requestStarted.promise;
    assert.equal(authorization, "Bearer old-tab-session-token");
    response.resolve({ ok: true, status: 200, json: async () => ({ success: true, revoked: true }) });
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(sharedValues.get("goalGambitToken"), "new-tab-session-token");
});

test("failed old logout keeps a newer cross-tab login", async () => {
    const request = deferred();
    const requestStarted = deferred();
    const sharedValues = new Map([["goalGambitToken", "old-tab-session-token"], ["goalGambitLoggedIn", "true"]]);
    const app = loadWebsiteApi(() => { requestStarted.resolve(); return request.promise; }, sharedValues);
    app.GG.logout();
    await requestStarted.promise;
    signInOtherTab(sharedValues);
    request.reject(new Error("network unavailable"));
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(app.location.href, "https://example.test/frontend/pages/index.html");
    assert.equal(sharedValues.get("goalGambitToken"), "new-tab-session-token");
    assert.equal(sharedValues.get("goalGambitUsername"), "player-b");
});

test("network failure still clears the initiating session when no newer login exists", async () => {
    const app = loadWebsiteApi(async () => { throw new Error("network unavailable"); });
    app.GG.logout();
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(app.location.href, "https://example.test/frontend/pages/index.html");
    assert.equal(app.localValues.has("goalGambitToken"), false);
});

test("old logout timeout keeps a newer cross-tab login and ignores its late response", async () => {
    const response = deferred();
    const requestStarted = deferred();
    const sharedValues = new Map([["goalGambitToken", "old-tab-session-token"], ["goalGambitLoggedIn", "true"]]);
    let requestSignal;
    const app = loadWebsiteApi((_url, options) => {
        requestSignal = options.signal;
        requestStarted.resolve();
        return response.promise;
    }, sharedValues);
    app.GG.logout();
    await requestStarted.promise;
    signInOtherTab(sharedValues);
    await waitFor(() => Boolean(app.location.href.includes("/pages/index.html")), 500);
    assert.equal(requestSignal.aborted, true);
    assert.equal(sharedValues.get("goalGambitToken"), "new-tab-session-token");
    response.resolve({ ok: true, status: 200, json: async () => ({ success: true, revoked: true }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sharedValues.get("goalGambitToken"), "new-tab-session-token");
    assert.equal(sharedValues.get("goalGambitUsername"), "player-b");
});
