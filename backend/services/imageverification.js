"use strict";

const { createWorker } = require("tesseract.js");
const english = require("@tesseract.js-data/eng");

let workerPromise = null;

function getWorker() {
    if (!workerPromise) {
        workerPromise = createWorker("eng", 1, {
            langPath: english.langPath,
            gzip: english.gzip,
            cacheMethod: "none",
            logger: function() {}
        }).then(async function(worker) {
            await worker.setParameters({
                tessedit_char_whitelist: "0123456789:-–",
                preserve_interword_spaces: "1"
            });
            return worker;
        }).catch(function(error) {
            workerPromise = null;
            throw error;
        });
    }
    return workerPromise;
}

function scorePairs(text) {
    const found = new Map();
    const pattern = /(^|[^0-9])([0-9]{1,2})\s*[-:–]\s*([0-9]{1,2})(?![0-9])/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const left = Number(match[2]);
        const right = Number(match[3]);
        if (left > 99 || right > 99) continue;
        const key = left + "-" + right;
        found.set(key, { home: left, away: right });
    }
    return Array.from(found.values());
}

async function analyzeScreenshot(buffer) {
    const worker = await getWorker();
    const result = await worker.recognize(buffer);
    const text = String(result && result.data && result.data.text || "").trim();
    return {
        text: text.slice(0, 4000),
        candidates: scorePairs(text)
    };
}

function matchesExpected(candidates, creatorScore, opponentScore) {
    if (!Array.isArray(candidates) || candidates.length !== 1) return false;
    const pair = candidates[0];
    const home = Number(creatorScore);
    const away = Number(opponentScore);
    // Different in-game display names and scoreboard orientation are normal.
    // The authenticated match participants and two reports identify the pair;
    // names recognized in the screenshot are not used as an identity check.
    return (pair.home === home && pair.away === away) ||
        (pair.home === away && pair.away === home);
}

module.exports = { analyzeScreenshot, scorePairs, matchesExpected };
