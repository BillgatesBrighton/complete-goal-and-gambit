"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const http = require("node:http");
require("./config").readConfig();
const { createFixture, verifiedPool } = require("./fixture");
const { readConfig, EXPECTED_DATABASE, EXPECTED_ROLE } = require("./config");
const { request } = require("./httpHarness");
const mpesaRoutes = require("../../routes/mpesa");

let fixture;
let inventoryPool;
let schemasBefore;
let server;
let base;

before(async () => {
    inventoryPool = await verifiedPool(readConfig());
    const identity = await inventoryPool.query("SELECT current_database() AS database_name,current_user AS role_name");
    assert.deepEqual(identity.rows[0], { database_name: EXPECTED_DATABASE, role_name: EXPECTED_ROLE });
    schemasBefore = (await inventoryPool.query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'security_it_%' ORDER BY nspname"
    )).rows.map(row => row.nspname);

    fixture = await createFixture();
    for (const [name, pool] of [["application", fixture.pool], ["Socket.IO lock", fixture.lockPool]]) {
        const result = await pool.query(
            "SELECT current_database() AS database_name,current_user AS role_name,current_schema() AS schema_name"
        );
        assert.deepEqual(result.rows[0], {
            database_name: EXPECTED_DATABASE,
            role_name: EXPECTED_ROLE,
            schema_name: fixture.schema
        }, name + " pool must be isolated before writes");
    }

    const app = express();
    app.use(express.json());
    app.use("/api/payments", mpesaRoutes(fixture.pool, (_req, _res, next) => next(), null));
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
    if (server && server.listening) await new Promise(resolve => server.close(resolve));
    if (fixture) await fixture.close();
    if (inventoryPool) {
        const schemasAfter = (await inventoryPool.query(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'security_it_%' ORDER BY nspname"
        )).rows.map(row => row.nspname);
        assert.deepEqual(schemasAfter, schemasBefore, "the run must preserve all pre-existing security_it_* schemas");
        await inventoryPool.end();
    }
});

async function createPendingDeposit(amount) {
    const user = await fixture.createUser("it_mpesa_stk_");
    const phone = "254712345678";
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await fixture.pool.query(
        "INSERT INTO wallets(user_id,balance,locked_balance,currency) VALUES($1,25,0,'KES')",
        [user.id]
    );
    const transaction = await fixture.pool.query(
        `INSERT INTO transactions
            (user_id,transaction_type,amount,currency,status,reference,mpesa_callback_token_hash,mpesa_payer_phone,description)
         VALUES($1,'deposit',$2,'KES','pending',$3,$4,$5,'integration STK deposit') RETURNING id`,
        [user.id, amount, "MPESA-INIT-" + crypto.randomUUID(), tokenHash, phone]
    );
    return { userId: user.id, transactionId: transaction.rows[0].id, token, phone, amount };
}

function payload(checkoutRequestId, resultCode, amount, phone) {
    const callback = { CheckoutRequestID: checkoutRequestId, ResultCode: resultCode, ResultDesc: "Integration callback" };
    if (resultCode === 0) {
        callback.CallbackMetadata = { Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: "QRS123TEST" },
            { Name: "PhoneNumber", Value: Number(phone) }
        ] };
    }
    return { Body: { stkCallback: callback } };
}

async function getState(deposit) {
    const [wallet, transaction, journals] = await Promise.all([
        fixture.pool.query("SELECT balance FROM wallets WHERE user_id=$1", [deposit.userId]),
        fixture.pool.query("SELECT status,reference FROM transactions WHERE id=$1", [deposit.transactionId]),
        fixture.pool.query(
            `SELECT t.id,t.reference,t.posted_at,COUNT(e.id)::int AS entry_count
               FROM financial_ledger_transactions t
               JOIN financial_ledger_entries e ON e.transaction_id=t.id
              WHERE t.reference=$1 GROUP BY t.id`,
            ["STK-RECEIPT-MPESA-" + deposit.checkoutRequestId]
        )
    ]);
    return { balance: Number(wallet.rows[0].balance), transaction: transaction.rows[0], journals: journals.rows };
}

test("legacy unauthenticated STK callback path cannot credit a wallet", async () => {
    const deposit = await createPendingDeposit(70);
    const response = await request(base, "/api/payments/callback", {
        method: "POST",
        body: payload("forged-checkout", 0, 70, deposit.phone)
    });
    assert.equal(response.status, 404);
    const row = await fixture.pool.query("SELECT balance FROM wallets WHERE user_id=$1", [deposit.userId]);
    assert.equal(Number(row.rows[0].balance), 25);
});

test("unknown callback capability cannot credit a deposit", async () => {
    const deposit = await createPendingDeposit(71);
    const wrongToken = crypto.randomBytes(32).toString("base64url");
    const response = await request(base, "/api/payments/callback/" + wrongToken, {
        method: "POST",
        body: payload("forged-checkout", 0, 71, deposit.phone)
    });
    assert.equal(response.status, 404);
    const state = await fixture.pool.query(
        "SELECT w.balance,t.status FROM wallets w JOIN transactions t ON t.user_id=w.user_id WHERE t.id=$1",
        [deposit.transactionId]
    );
    assert.deepEqual(state.rows[0], { balance: "25.00", status: "pending" });
});

test("callback amount mismatch leaves transaction, wallet and ledger unchanged", async () => {
    const deposit = await createPendingDeposit(72);
    deposit.checkoutRequestId = "checkout-amount-mismatch";
    const response = await request(base, "/api/payments/callback/" + deposit.token, {
        method: "POST",
        body: payload(deposit.checkoutRequestId, 0, 73, deposit.phone)
    });
    assert.equal(response.status, 503);
    const state = await fixture.pool.query(
        `SELECT w.balance,t.status,COUNT(l.id)::int AS ledger_count
           FROM wallets w JOIN transactions t ON t.user_id=w.user_id
           LEFT JOIN financial_ledger_transactions l ON l.reference=$2
          WHERE t.id=$1 GROUP BY w.balance,t.status`,
        [deposit.transactionId, "STK-RECEIPT-MPESA-" + deposit.checkoutRequestId]
    );
    assert.deepEqual(state.rows[0], { balance: "25.00", status: "pending", ledger_count: 0 });
});

test("callback phone mismatch leaves transaction, wallet and ledger unchanged", async () => {
    const deposit = await createPendingDeposit(73);
    deposit.checkoutRequestId = "checkout-phone-mismatch";
    const response = await request(base, "/api/payments/callback/" + deposit.token, {
        method: "POST",
        body: payload(deposit.checkoutRequestId, 0, 73, "254798765432")
    });
    assert.equal(response.status, 503);
    const row = await fixture.pool.query(
        "SELECT w.balance,t.status FROM wallets w JOIN transactions t ON t.user_id=w.user_id WHERE t.id=$1",
        [deposit.transactionId]
    );
    assert.deepEqual(row.rows[0], { balance: "25.00", status: "pending" });
});

test("valid callback credits once under concurrent duplicate delivery", async () => {
    const deposit = await createPendingDeposit(74);
    deposit.checkoutRequestId = "checkout-valid-once";
    const callback = () => request(base, "/api/payments/callback/" + deposit.token, {
        method: "POST",
        body: payload(deposit.checkoutRequestId, 0, 74, deposit.phone)
    });
    const responses = await Promise.all([callback(), callback()]);
    assert.ok(responses.every(response => response.status === 200));
    const state = await getState(deposit);
    assert.equal(state.balance, 99);
    assert.deepEqual(state.transaction, { status: "completed", reference: "MPESA-checkout-valid-once" });
    assert.equal(state.journals.length, 1);
    assert.equal(state.journals[0].entry_count, 2);
    assert.ok(state.journals[0].posted_at);
});

test("failed callback cannot overwrite or credit a later success state", async () => {
    const deposit = await createPendingDeposit(75);
    deposit.checkoutRequestId = "checkout-failed-first";
    const failed = await request(base, "/api/payments/callback/" + deposit.token, {
        method: "POST",
        body: payload(deposit.checkoutRequestId, 1, 0, deposit.phone)
    });
    assert.equal(failed.status, 200);
    const laterSuccess = await request(base, "/api/payments/callback/" + deposit.token, {
        method: "POST",
        body: payload(deposit.checkoutRequestId, 0, 75, deposit.phone)
    });
    assert.equal(laterSuccess.status, 200);
    const row = await fixture.pool.query(
        `SELECT w.balance,t.status,COUNT(l.id)::int AS journal_count
           FROM wallets w JOIN transactions t ON t.user_id=w.user_id
           LEFT JOIN financial_ledger_transactions l ON l.reference=$2
          WHERE t.id=$1 GROUP BY w.balance,t.status`,
        [deposit.transactionId, "STK-RECEIPT-MPESA-" + deposit.checkoutRequestId]
    );
    assert.deepEqual(row.rows[0], { balance: "25.00", status: "failed", journal_count: 0 });
});

test("ledger failure rolls back wallet credit and reports reconciliation instead of promising provider retry", async () => {
    const deposit = await createPendingDeposit(76);
    deposit.checkoutRequestId = "checkout-ledger-failure";
    const pendingReference = (await fixture.pool.query(
        "SELECT reference FROM transactions WHERE id=$1", [deposit.transactionId]
    )).rows[0].reference;
    await fixture.pool.query(`
        CREATE FUNCTION security_it_fail_stk_ledger_entry() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'security integration forced STK journal rollback';
        END;
        $$ LANGUAGE plpgsql`);
    await fixture.pool.query(`
        CREATE TRIGGER security_it_fail_stk_ledger_entry
        BEFORE INSERT ON financial_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION security_it_fail_stk_ledger_entry()`);
    const response = await request(base, "/api/payments/callback/" + deposit.token, {
        method: "POST",
        body: payload(deposit.checkoutRequestId, 0, deposit.amount, deposit.phone)
    });
    assert.equal(response.status, 503);
    assert.match(response.body.ResultDesc, /reconcile the payment with Safaricom/);
    const state = await fixture.pool.query(
        `SELECT w.balance,t.status,t.reference,
                (SELECT COUNT(*)::int FROM financial_ledger_transactions WHERE reference=$2) AS journal_count
           FROM wallets w JOIN transactions t ON t.user_id=w.user_id
          WHERE t.id=$1`,
        [deposit.transactionId, "STK-RECEIPT-MPESA-" + deposit.checkoutRequestId]
    );
    assert.deepEqual(state.rows[0], { balance: "25.00", status: "pending", reference: pendingReference, journal_count: 0 });
    await fixture.pool.query("DROP TRIGGER security_it_fail_stk_ledger_entry ON financial_ledger_entries");
    await fixture.pool.query("DROP FUNCTION security_it_fail_stk_ledger_entry()");
});
