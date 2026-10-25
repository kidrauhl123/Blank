\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.api_tokens') IS NOT NULL
     OR to_regclass('public.api_clients') IS NOT NULL
     OR to_regclass('public.mcp_invocations') IS NOT NULL
     OR EXISTS (SELECT 1 FROM retired_api_tokens WHERE revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM retired_api_clients WHERE status<>'REVOKED') THEN
    RAISE EXCEPTION 'External access invariant failed: retirement incomplete';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ledger_entries
    GROUP BY ledger_transaction_id
    HAVING sum(amount_minor) <> 0 OR count(*) < 2
  ) THEN
    RAISE EXCEPTION 'Ledger invariant failed: unbalanced transaction';
  END IF;

  IF EXISTS (SELECT 1 FROM accounts WHERE customer_id IS NOT NULL AND available_balance_minor < 0) THEN
    RAISE EXCEPTION 'Customer account invariant failed: negative balance';
  END IF;

  IF EXISTS (
    SELECT operation_id FROM transfers
    GROUP BY operation_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Idempotency invariant failed: duplicate operation id';
  END IF;

  IF EXISTS (
    SELECT 1 FROM customers c
    LEFT JOIN auth_credentials a ON a.customer_id=c.id
    WHERE a.customer_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Identity invariant failed: customer without credentials';
  END IF;

  IF EXISTS (
    SELECT 1 FROM accounts WHERE customer_id IS NULL AND system_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Account invariant failed: ownerless non-system account';
  END IF;

  IF EXISTS (
    SELECT 1 FROM investment_positions p JOIN accounts a ON a.id=p.account_id WHERE p.customer_id<>a.customer_id OR a.customer_id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM investment_orders o WHERE (o.quote IS NOT NULL OR o.suitability_evidence->>'source'='DEMO_SEED') AND o.status='SUCCEEDED'
      AND (o.receipt IS NULL OR o.position_id IS NULL OR NOT EXISTS
        (SELECT 1 FROM ledger_transactions l WHERE l.reference='LED-'||o.operation_id))
  ) THEN
    RAISE EXCEPTION 'Investment invariant failed: ownership or committed receipt mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM investment_orders o
    WHERE (o.quote IS NOT NULL OR o.suitability_evidence->>'source'='DEMO_SEED') AND o.status='SUCCEEDED'
      AND (
        (SELECT count(*) FROM bank_transactions bt
         WHERE bt.account_id=o.account_id AND bt.metadata->>'operationId'=o.operation_id)<>1
        OR NOT EXISTS (
          SELECT 1 FROM bank_transactions bt
          JOIN accounts a ON a.id=bt.account_id AND a.customer_id=o.customer_id
          JOIN ledger_transactions l ON l.reference=o.receipt->>'ledgerReference'
          JOIN ledger_entries e ON e.ledger_transaction_id=l.id AND e.account_id=bt.account_id
          WHERE bt.account_id=o.account_id AND bt.metadata->>'operationId'=o.operation_id
            AND o.receipt->>'operationId'=o.operation_id
            AND o.receipt->>'side'=o.side AND (o.receipt->>'amountMinor')::bigint=o.amount_minor
            AND bt.metadata->>'ledgerReference'=l.reference
            AND bt.amount_minor=CASE WHEN o.side='SUBSCRIBE' THEN -o.amount_minor ELSE (o.receipt->>'settlementMinor')::bigint END
            AND e.amount_minor=bt.amount_minor AND bt.occurred_at=l.posted_at AND o.executed_at=bt.occurred_at
        )
      )
  ) THEN
    RAISE EXCEPTION 'Investment invariant failed: receipt, cash transaction or ledger mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_runtime_runs r JOIN agent_threads t ON t.id=r.agent_thread_id
    WHERE r.customer_id<>t.customer_id
  ) THEN
    RAISE EXCEPTION 'Agent invariant failed: run/thread tenant mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_threads t JOIN channel_identities i ON i.id=t.channel_identity_id
    WHERE t.customer_id<>i.customer_id OR t.channel_type<>i.channel_type
  ) THEN
    RAISE EXCEPTION 'Channel invariant failed: thread identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM channel_outbox o JOIN channel_identities i ON i.id=o.channel_identity_id
    WHERE o.customer_id<>i.customer_id OR o.channel_type<>i.channel_type
  ) THEN
    RAISE EXCEPTION 'Channel invariant failed: outbox identity mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_runtime_runs
    WHERE status='INTERRUPTED'
      AND (task_id IS NULL OR operation_id IS NULL OR interrupt_kind IS NULL OR final_reply IS NULL)
  ) THEN
    RAISE EXCEPTION 'Agent invariant failed: incomplete interrupt state';
  END IF;
END $$;

SELECT 'All banking invariants passed' AS result;
