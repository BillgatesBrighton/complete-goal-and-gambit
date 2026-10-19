"use strict";

const { recordJournal, cents } = require("./financialLedger");

async function lockPlatformWallets(client) {
    const admins = await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id FOR UPDATE");
    if (!admins.rows.length) throw Object.assign(new Error("No platform administrator wallet is available."), { status: 503 });
    for (const admin of admins.rows) {
        await client.query("INSERT INTO admin_wallets(admin_id) VALUES($1) ON CONFLICT(admin_id) DO NOTHING", [admin.id]);
    }
    const wallets = await client.query(
        `SELECT admin_id,balance,reserved_balance,currency FROM admin_wallets
          WHERE admin_id=ANY($1::int[]) ORDER BY admin_id FOR UPDATE`,
        [admins.rows.map((admin) => Number(admin.id))]
    );
    if (wallets.rows.length !== admins.rows.length) throw new Error("Platform wallet rows are incomplete.");
    return wallets.rows.map((row) => ({
        adminId: Number(row.admin_id),
        balanceCents: cents(row.balance),
        reservedCents: cents(row.reserved_balance || 0)
    }));
}

function splitCents(amountCents, wallets) {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0 || !wallets.length) throw new Error("Invalid platform allocation.");
    const base = Math.floor(amountCents / wallets.length);
    let remainder = amountCents - base * wallets.length;
    return wallets.map((wallet) => {
        const share = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        return { adminId: wallet.adminId, cents: share };
    }).filter((item) => item.cents > 0);
}

async function creditPlatform(client, options) {
    const amountCents = cents(options.amount);
    if (amountCents <= 0) throw new Error("Platform credits must be positive.");
    const wallets = await lockPlatformWallets(client);
    const allocations = splitCents(amountCents, wallets);
    const postings = (options.debitPostings || []).slice();
    for (const allocation of allocations) {
        const amount = (allocation.cents / 100).toFixed(2);
        await client.query(
            `UPDATE admin_wallets SET balance=balance+$1,
                    reserved_balance=reserved_balance+$2,updated_at=NOW()
              WHERE admin_id=$3`,
            [amount, options.reserve ? amount : "0.00", allocation.adminId]
        );
        const reference = `${options.reference}-A${allocation.adminId}`;
        await client.query(
            `INSERT INTO admin_wallet_transactions
                (admin_id,transaction_type,amount,currency,status,reference,description,match_id)
             VALUES($1,$2,$3,'KES','completed',$4,$5,$6)`,
            [allocation.adminId, options.transactionType, amount, reference,
                String(options.description || "").slice(0, 500), options.matchId || null]
        );
        postings.push({
            accountType: options.reserve ? "admin_wallet_reserved" : "admin_wallet_available",
            accountId: allocation.adminId,
            credit: amount
        });
    }
    await recordJournal(client, {
        reference: options.reference,
        transactionType: options.transactionType,
        amount: amountCents / 100,
        description: options.description,
        context: options.context,
        postings
    });
    return allocations;
}

async function debitPlatformAvailable(client, options) {
    const amountCents = cents(options.amount);
    if (amountCents <= 0) throw new Error("Platform debits must be positive.");
    const wallets = await lockPlatformWallets(client);
    const availableCents = wallets.reduce((sum, wallet) => sum + wallet.balanceCents - wallet.reservedCents, 0);
    if (availableCents < amountCents) {
        throw Object.assign(new Error("Available platform funds are insufficient; the payout was held."), { status: 409, code: "INSUFFICIENT_PLATFORM_FUNDS" });
    }
    let remaining = amountCents;
    const allocations = [];
    for (const wallet of wallets) {
        if (!remaining) break;
        const available = wallet.balanceCents - wallet.reservedCents;
        const share = Math.min(available, remaining);
        if (share <= 0) continue;
        const amount = (share / 100).toFixed(2);
        await client.query(
            "UPDATE admin_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 AND balance-reserved_balance >= $1",
            [amount, wallet.adminId]
        );
        await client.query(
            `INSERT INTO admin_wallet_transactions
                (admin_id,transaction_type,amount,currency,status,reference,description,match_id)
             VALUES($1,$2,$3,'KES','completed',$4,$5,$6)`,
            [wallet.adminId, options.transactionType, amount, `${options.reference}-A${wallet.adminId}`,
                String(options.description || "").slice(0, 500), options.matchId || null]
        );
        allocations.push({ adminId: wallet.adminId, cents: share });
        remaining -= share;
    }
    const postings = allocations.map((item) => ({
        accountType: "admin_wallet_available", accountId: item.adminId, debit: (item.cents / 100).toFixed(2)
    })).concat(options.creditPostings || []);
    await recordJournal(client, {
        reference: options.reference,
        transactionType: options.transactionType,
        amount: amountCents / 100,
        description: options.description,
        context: options.context,
        postings
    });
    return allocations;
}

async function releasePlatformReservation(client, reference, description) {
    const allocations = await client.query(
        `SELECT e.account_id,SUM(e.credit)::numeric(14,2) AS amount
           FROM financial_ledger_transactions t
           JOIN financial_ledger_entries e ON e.transaction_id=t.id
          WHERE t.reference=$1 AND e.account_type='admin_wallet_reserved' AND e.credit>0
          GROUP BY e.account_id ORDER BY e.account_id`,
        [reference]
    );
    const postings = [];
    let totalCents = 0;
    for (const row of allocations.rows) {
        const amountCents = cents(row.amount);
        if (!amountCents) continue;
        const amount = (amountCents / 100).toFixed(2);
        const updated = await client.query(
            `UPDATE admin_wallets SET reserved_balance=reserved_balance-$1,updated_at=NOW()
              WHERE admin_id=$2 AND reserved_balance >= $1 RETURNING admin_id`,
            [amount, row.account_id]
        );
        if (!updated.rows.length) throw new Error("Reserved competition funds are inconsistent; settlement was stopped.");
        postings.push({ accountType: "admin_wallet_reserved", accountId: Number(row.account_id), debit: amount });
        postings.push({ accountType: "admin_wallet_available", accountId: Number(row.account_id), credit: amount });
        totalCents += amountCents;
    }
    if (totalCents) {
        await recordJournal(client, {
            reference: `${reference}-RELEASE`, transactionType: "competition_reserve_release",
            amount: totalCents / 100, description: description || "Competition funds released after settlement",
            context: { entryReference: reference }, postings
        });
    }
    return totalCents / 100;
}

async function refundReservedPlatformFee(client, options) {
    const amountCents = cents(options.amount);
    const sourceReference = options.entryReference;
    if (!amountCents || !sourceReference) throw new Error("A reserved competition fee reference is required.");
    const source = await client.query(
        `SELECT e.account_id,SUM(e.credit)::numeric(14,2) AS amount
           FROM financial_ledger_transactions t
           JOIN financial_ledger_entries e ON e.transaction_id=t.id
          WHERE t.reference=$1 AND e.account_type='admin_wallet_reserved' AND e.credit>0
          GROUP BY e.account_id ORDER BY e.account_id`,
        [sourceReference]
    );
    const allocations = source.rows.map((row) => ({ adminId: Number(row.account_id), cents: cents(row.amount) }));
    if (allocations.reduce((sum, row) => sum + row.cents, 0) !== amountCents) {
        throw new Error("The original reserved entry fee cannot be reconciled; refund was stopped.");
    }
    await lockPlatformWallets(client);
    const postings = [];
    for (const allocation of allocations) {
        const amount = (allocation.cents / 100).toFixed(2);
        const updated = await client.query(
            `UPDATE admin_wallets
                SET balance=balance-$1,reserved_balance=reserved_balance-$1,updated_at=NOW()
              WHERE admin_id=$2 AND balance >= $1 AND reserved_balance >= $1
              RETURNING admin_id`,
            [amount, allocation.adminId]
        );
        if (!updated.rows.length) throw new Error("Reserved platform funds are unavailable; refund was stopped safely.");
        await client.query(
            `INSERT INTO admin_wallet_transactions
                (admin_id,transaction_type,amount,currency,status,reference,description)
             VALUES($1,$2,$3,'KES','completed',$4,$5)`,
            [allocation.adminId, options.transactionType, amount,
                `${options.reference}-A${allocation.adminId}`, String(options.description || "").slice(0, 500)]
        );
        postings.push({ accountType: "admin_wallet_reserved", accountId: allocation.adminId, debit: amount });
    }
    await client.query("UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2", [(amountCents / 100).toFixed(2), options.userId]);
    postings.push({ accountType: "user_wallet_available", accountId: Number(options.userId), credit: (amountCents / 100).toFixed(2) });
    await recordJournal(client, {
        reference: options.reference,
        transactionType: options.transactionType,
        amount: amountCents / 100,
        description: options.description,
        context: options.context,
        postings
    });
}

module.exports = { lockPlatformWallets, splitCents, creditPlatform, debitPlatformAvailable, releasePlatformReservation, refundReservedPlatformFee };
