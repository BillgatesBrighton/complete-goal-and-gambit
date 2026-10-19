"use strict";

function cents(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Financial ledger amounts must be non-negative finite values.");
    return Math.round(amount * 100);
}

/**
 * Records one balanced, immutable journal transaction. Call inside the same
 * PostgreSQL transaction as the wallet balance changes it describes.
 */
async function recordJournal(client, details) {
    const postings = Array.isArray(details && details.postings) ? details.postings : [];
    if (!details || !details.reference || !details.transactionType || postings.length < 2) {
        throw new Error("A financial journal needs a reference, type, and at least two postings.");
    }

    let debits = 0;
    let credits = 0;
    const normalized = postings.map((posting) => {
        const debitCents = cents(posting.debit || 0);
        const creditCents = cents(posting.credit || 0);
        if ((debitCents > 0) === (creditCents > 0)) {
            throw new Error("Each financial journal posting must be either a debit or a credit.");
        }
        if (!posting.accountType) throw new Error("A financial journal account type is required.");
        debits += debitCents;
        credits += creditCents;
        return {
            accountType: String(posting.accountType),
            accountId: posting.accountId === undefined ? null : posting.accountId,
            debit: (debitCents / 100).toFixed(2),
            credit: (creditCents / 100).toFixed(2)
        };
    });
    if (debits <= 0 || debits !== credits) {
        throw new Error("Financial journal debits and credits must be equal and greater than zero.");
    }

    const result = await client.query(
        `INSERT INTO financial_ledger_transactions
            (reference,transaction_type,amount,currency,description,context)
         VALUES($1,$2,$3,'KES',$4,$5::jsonb)
         RETURNING id`,
        [String(details.reference), String(details.transactionType), (debits / 100).toFixed(2),
            String(details.description || "").slice(0, 500), JSON.stringify(details.context || {})]
    );
    const transactionId = Number(result.rows[0].id);
    for (const posting of normalized) {
        await client.query(
            `INSERT INTO financial_ledger_entries
                (transaction_id,account_type,account_id,debit,credit)
             VALUES($1,$2,$3,$4,$5)`,
            [transactionId, posting.accountType, posting.accountId, posting.debit, posting.credit]
        );
    }
    const posted = await client.query(
        `UPDATE financial_ledger_transactions SET posted_at=NOW()
          WHERE id=$1 AND posted_at IS NULL RETURNING id`,
        [transactionId]
    );
    if (!posted.rows.length) throw new Error("The financial journal could not be posted exactly once.");
    return { id: transactionId, amount: debits / 100 };
}

module.exports = { recordJournal, cents };
