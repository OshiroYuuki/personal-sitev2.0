---
title: "PATS Devlog #1 | Building a High-Throughput gRPC Payment Server in Rust"
description: "How I built a concurrent gRPC payment backend in Rust capable of 15,000–25,000 transactions per second, complete with double-spend protection and load testing."
date: "May 22 2026"
series: "PATS"
---

After staring at terminal windows for longer than I'd like to admit, I finally got my load test to output the numbers I've been chasing all week.

If you spend enough time trying to build a payment network, you quickly realize you aren't just writing an app you are building a high-stakes, concurrent engine. After spending so much time recently wrestling with the quirks of Java JFrames and the anxiety of manual memory allocation in C data structures, I wanted a break from the usual. I wanted raw, predictable speed. No unpredictable Garbage Collection pauses spiking my latency, and absolutely no catastrophic segfaults.

So, I built it in Rust. Here is my breakdown of how I pieced together a concurrent payment backend from the ground up.

---

### Step 1: Throwing Out JSON for Protobufs

I knew from the start I didn't want to use REST. Sending bulky JSON text over HTTP feels too brittle for a high-throughput financial system. Instead, I went with `tonic`, Rust's library for gRPC.

The beauty of gRPC is that it forced me to sit down and write a strict, ironclad contract before I wrote a single line of server logic. I defined everything in a `.proto` file, which gets compiled into an incredibly fast binary format. If I try to send a string where an integer is expected, my code won't even compile.

Here is what my payment contract ended up looking like:

```protobuf
syntax = "proto3";
package payment;

service TdxPaymentNetwork {
    rpc ProcessTransaction (TransactionRequest) returns (TransactionResponse);
    rpc TriggerDailyExport (AdminRequest) returns (AdminResponse);
}

message TransactionRequest {
    string merchant_id   = 1;
    string user_token    = 2;
    double amount        = 3;
    uint64 nonce         = 4;
    string user_signature = 5;
    string pos_signature  = 6;
}

message TransactionResponse {
    uint64 nonce     = 1;
    string status    = 2;
    string tdx_quote = 3;
}

message AdminRequest {
    string admin_key = 1;
}

message AdminResponse {
    string message = 1;
}
```

Keeping the response minimal was a deliberate choice. I just needed the server to echo back the `nonce` (the transaction ID) and a status of `"APPROVED"` or `"DENIED"`. I also included a `tdx_quote` field for hardware-level security attestation — which was a whole separate rabbit hole I fell down.

---

### Step 2: The Paranoia of Shared State

The scariest part of this build was figuring out how to store the money. I was going to have hundreds of background tasks running simultaneously. If two tasks tried to deduct money from the same user at the exact same microsecond, I could accidentally corrupt the entire ledger.

In C, this is where I'd start sweating over thread locks and data races. But Rust handles this beautifully with the `Arc<Mutex<T>>` pattern.

```rust
#[derive(Debug)]
struct State {
    balances:      HashMap<String, f64>,
    transactions:  Vec<TxLog>,
    seen_nonces:   HashSet<u64>,
}

pub struct TdxService {
    state:              Arc<Mutex<State>>,
    initial_state_root: String,
}
```

I essentially built a vault (`State`) containing my balances and transaction logs. Then I put a heavy lock on the door (`Mutex`). When a transaction comes in, it has to grab the lock, do the math, and release it before the next transaction can step inside. Finally, I wrapped the whole thing in an `Arc` (Atomic Reference Counted pointer) so I could safely hand copies of that lock to thousands of asynchronous workers without Rust's strict compiler yelling at me.

---

### Step 3: My Shield Against Double-Spends

I spent a lot of time thinking about network drops. If a user's Wi-Fi cuts out right after they hit "pay," their phone is going to automatically retry. If my server is naive, it processes the payment twice.

To fix this, I relied on the `nonce` from my protobuf schema as an **idempotency key**. Here is the actual heart of my server's logic:

```rust
enum ApplyResult {
    Approved,
    Denied,
    Duplicate,
}

fn apply_transaction(
    state:  &mut State,
    tx:     &OfflineTx,
    source: &str,
) -> ApplyResult {
    // The Double-Spend Shield
    if !state.seen_nonces.insert(tx.nonce) {
        return ApplyResult::Duplicate;
    }

    let user_balance = state
        .balances
        .get(&tx.user_token)
        .copied()
        .unwrap_or(-1.0);

    let approved = user_balance >= 0.0
        && tx.amount > 0.0
        && user_balance >= tx.amount;

    if approved {
        *state.balances.entry(tx.user_token.clone()).or_insert(0.0) -= tx.amount;
        *state.balances.entry(tx.merchant_id.clone()).or_insert(0.0) += tx.amount;

        state.transactions.push(TxLog {
            nonce:         tx.nonce,
            merchant_id:   tx.merchant_id.clone(),
            user_token:    tx.user_token.clone(),
            amount:        tx.amount,
            user_signature: tx.user_signature.clone(),
            pos_signature:  tx.pos_signature.clone(),
            timestamp_ms:  now_ms(),
            source:        source.to_string(),
        });

        ApplyResult::Approved
    } else {
        ApplyResult::Denied
    }
}
```

The very first thing I do inside the Mutex lock is attempt to insert the `nonce` into a `HashSet`. If it's already in there, `.insert()` immediately returns `false`, and I abort the transaction before a single penny is touched. Simple, bulletproof, and extremely fast.

---

### Step 4: Hammering the Server

Building it was one thing; proving it worked under pressure was another. I wrote a dedicated load-test client to simulate hundreds of point-of-sale terminals firing simultaneously.

I pre-generated 10,000 deterministic transactions in memory using a fast `xorshift` algorithm, then unleashed Tokio on the server.

```rust
let semaphore = Arc::new(Semaphore::new(CONCURRENCY));
let mut handles = Vec::with_capacity(TOTAL_TXS as usize);

for idx in 0..TOTAL_TXS as usize {
    let permit      = semaphore.clone().acquire_owned().await.unwrap();
    let tx_data     = batch[idx].clone();
    let mut client  = network_client.clone();

    let approved_ref = approved.clone();
    let denied_ref   = denied.clone();

    let handle = tokio::spawn(async move {
        let req = tonic::Request::new(TransactionRequest {
            merchant_id: tx_data.merchant_id,
            // ... other fields
        });

        match client.process_transaction(req).await {
            Ok(response) => {
                if response.into_inner().status == "APPROVED" {
                    approved_ref.fetch_add(1, Ordering::Relaxed);
                } else {
                    denied_ref.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(e) => eprintln!("Network error: {:?}", e),
        }

        drop(permit); // release the semaphore slot
    });

    handles.push(handle);
}

for handle in handles {
    let _ = handle.await;
}
```

I used `tokio::spawn` to blast off thousands of lightweight background tasks. But firing them all at once would crash my own network card, so I added a `Semaphore` as a bouncer — capping concurrency at exactly 500 connections at any given moment. To keep score without slowing down the test, I used hardware-level `AtomicU64` counters (`fetch_add`) to tally results safely across all those chaotic threads.

---

### The Payoff

When the load test finished and all the threads quietly collapsed, the main thread tallied up the stopwatch:

```rust
let elapsed       = start.elapsed();
let final_approved = approved.load(Ordering::Relaxed);
let final_denied   = denied.load(Ordering::Relaxed);
let total          = final_approved + final_denied;
let tps            = total as f64 / elapsed.as_secs_f64();

println!("=== Load Test Complete ===");
println!("Total Executed: {}", total);
println!("Approved:       {}", final_approved);
println!("Denied:         {}", final_denied);
println!("Elapsed Time:   {:.2?}", elapsed);
println!("Throughput:     {:.2} TPS", tps);
```

Even running locally, the server chewed through the traffic at **15,000 to 25,000 Transactions Per Second**.

Watching that terminal output appear without a single crash or memory leak made all the debugging worth it. Rust forced me to be disciplined upfront, but the reward was a concurrent backend that feels utterly unbreakable.
