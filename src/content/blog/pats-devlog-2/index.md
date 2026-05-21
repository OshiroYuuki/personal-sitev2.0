---
title: "PATS Devlog #2 | Intel TDX Attestation in Rust: Getting a Hardware Report Without a Library"
description: "How I bypassed Intel's C attestation library and pulled a hardware TDX quote directly from the CPU using pure Rust and a raw kernel ioctl, binding the payment ledger to silicon-level cryptographic proof."
date: "May 22 2026"
series: "PATS"
---

When architecting this high-throughput payment network, hardware-level isolation was a foundational requirement, not an afterthought. Standard memory-safe languages like Rust protect against application-level bugs, but they cannot defend against a compromised host operating system. If a malicious cloud provider or a root-level attacker can read the RAM of the VM, the ledger is effectively public, and state roots can be spoofed.

Because of this, I planned from the beginning to deploy the core engine inside an Intel TDX (Trust Domain Extensions) enclave. TDX isolates the VM at the silicon level, keeping the host OS completely blind to the operations happening inside. However, hardware isolation is only half the equation; security requires mathematically verifiable proof. I needed the enclave to prove to the outside world and to downstream zkVMs that it had not been tampered with.

Here is a breakdown of how I bypassed the standard C library dependencies and pulled a hardware attestation quote directly from the Intel CPU using pure Rust and a raw kernel `ioctl`.

---

### What Intel TDX Is (and Why Software Isn't Enough)

In standard cloud computing, the hypervisor manages memory, networks, and CPU scheduling. Running a payment server on a standard cloud instance means implicitly trusting that hypervisor not to inspect or alter the VM's memory.

Intel TDX flips this dynamic by creating a hardware-enforced "Trust Domain." The memory is encrypted with a key held exclusively by the CPU package. The hypervisor can still schedule the VM, but any attempt to read the memory results in encrypted ciphertext.

However, if the host is blind, clients and external auditors need a mechanism to verify that the server is actually running inside an authentic TDX enclave and not a standard, vulnerable Linux VM. This requires an attestation pipeline.

### The Pipeline: TDREPORT → Quote → zkVM Verification

The goal of this pipeline is to produce an unforgeable cryptographic receipt. The process operates as follows:

1. **The Request:** The Rust server asks the Intel CPU hardware for a `TDREPORT`.
2. **The Binding:** A cryptographic hash of the daily payment ledger is injected directly into the hardware report.
3. **The Quote:** The CPU signs the report using a hardware-fused private key, generating the final "Quote."
4. **The Verification:** An external auditor or a zero-knowledge VM (like SP1) ingests this Quote. Because the zkVM is aware of Intel's public keys, it can verify that this specific Rust binary produced this specific ledger state inside a secure silicon vault.

### Bypassing C Dependencies for Direct `ioctl`

The standard approach for requesting this report involves Intel's `libtdx_attest.so`. However, introducing a large C shared library into a pure Rust project creates significant friction. It requires maintaining FFI bindings, managing complex `build.rs` scripts, and tethering a portable Rust binary to an external C dependency tree.

For a security-critical path, I wanted full visibility into the execution. Reviewing the Linux kernel source code revealed that the library ultimately performs a very straightforward task: opening a file descriptor to `/dev/tdx_guest` and sending a raw `ioctl` command directly to the CPU.

To keep the architecture clean and isolated, I opted to skip the external library entirely and implement the `ioctl` call in pure Rust.

---

### Breaking Down `TDX_CMD_GET_REPORT0`

To interface with the hardware, the memory layout must perfectly match what the CPU expects. According to the Linux kernel headers (`linux/tdx-guest.h`), the CPU requires a struct containing 64 bytes of custom user data and an empty 1024-byte buffer to write the report into.

Here is the `C` representation built natively in Rust using `#[repr(C)]`:

```rust
const TDX_REPORT_DATA_LEN: usize = 64;
const TDX_REPORT_LEN: usize = 1024;

#[repr(C)]
struct TdxReportReq {
    report_data: [u8; TDX_REPORT_DATA_LEN],
    td_report:   [u8; TDX_REPORT_LEN],
}
```

The specific command required to trigger the CPU is `0xC4405401`. This hex string is the result of Linux `_IOWR` macro math, translating to:

- **Direction (Read/Write):** `3` (binary `11`)
- **Size of the struct:** 64 + 1024 = `1088` bytes (hex `0x440`)
- **Magic Char:** `'T'` (hex `0x54` for TDX)
- **Command Number:** `1` (hex `0x01`)

Packing those into a 32-bit integer yields `(3 << 30) | (0x440 << 16) | (0x54 << 8) | 0x01`, resulting in the `0xC4405401` command code.

---

### Binding the Ledger (The SHA-256 Anchor)

A hardware quote is only valuable if it is cryptographically bound to the actual execution state. An isolated signature simply stating "The VM is secure" is vulnerable to replay attacks.

To anchor the hardware quote to the financial math, I utilized the `report_data` field:

```rust
let hash = Sha256::digest(report_data_input);
req.report_data[..32].copy_from_slice(&hash);
```

When the end-of-day export is triggered, the server takes the `initial_state_root`, the `final_state_root`, the `tx_count`, and the `timestamp`, hashing them into a single SHA-256 fingerprint. This hash is injected into the first 32 bytes of the `report_data`.

When the CPU generates the Quote, it cryptographically seals this specific hash inside of it, meaning the Intel hardware is directly signing the integrity of the ledger.

---

### The Full Function & Feature Gating

For local development environments that lack TDX hardware, hardcoding this `ioctl` call would cause immediate crashes. To maintain a smooth development loop while preserving the production architecture, I used Rust's `#[cfg(feature = "...")]` flags to isolate the hardware calls.

Here is the implementation for both the production and mock paths:

```rust
#[cfg(feature = "tdx-attest")]
fn generate_tdx_quote(report_data_input: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    use std::fs::OpenOptions;
    use std::os::unix::io::AsRawFd;

    const TDX_REPORT_DATA_LEN: usize = 64;
    const TDX_REPORT_LEN: usize = 1024;
    // ioctl: _IOWR('T', 1, struct{[u8;64],[u8;1024]}) — kernel linux/tdx-guest.h
    const TDX_CMD_GET_REPORT0: libc::c_ulong = 0xC4405401;

    #[repr(C)]
    struct TdxReportReq {
        report_data: [u8; TDX_REPORT_DATA_LEN],
        td_report:   [u8; TDX_REPORT_LEN],
    }

    let mut req = TdxReportReq {
        report_data: [0u8; TDX_REPORT_DATA_LEN],
        td_report:   [0u8; TDX_REPORT_LEN],
    };

    let hash = Sha256::digest(report_data_input);
    req.report_data[..32].copy_from_slice(&hash);

    let fd = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tdx_guest")
        .map_err(|e| format!("open /dev/tdx_guest failed: {}. Is this a TDX guest?", e))?;

    let ret = unsafe {
        libc::ioctl(
            fd.as_raw_fd(),
            TDX_CMD_GET_REPORT0,
            &mut req as *mut TdxReportReq,
        )
    };

    if ret != 0 {
        let errno = unsafe { *libc::__errno_location() };
        return Err(format!(
            "ioctl TDX_CMD_GET_REPORT0 failed: errno={} ({})",
            errno,
            std::io::Error::from_raw_os_error(errno),
        ));
    }

    Ok((req.td_report.to_vec(), "real_tdx_hw_report"))
}

#[cfg(not(feature = "tdx-attest"))]
fn generate_tdx_quote(report_data_input: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    let h = Sha256::digest(report_data_input);
    let mock = format!("MOCK_TDX_QUOTE_NO_HW_SHA256_{}", hex::encode(h));
    Ok((mock.into_bytes(), "mock"))
}
```

This is controlled via a simple feature block in `Cargo.toml`:

```toml
[features]
default     = []
tdx-attest  = []
```

Compiling for the enclave requires `cargo build --release --features tdx-attest`, while standard development runs fall back to the mock function automatically.

---

### The Final Payload

When the daily ledger export completes, the system produces a JSON receipt containing the full operational state and the cryptographic proof.

```rust
#[derive(Serialize, Deserialize)]
struct DailyLedgerExport {
    initial_state_root:  String,
    final_state_root:    String,
    tx_count:            usize,
    transactions:        Vec<TxLog>,
    final_balances:      HashMap<String, f64>,
    export_timestamp_ms: u128,
    attestation_mode:    String,
    tdx_quote_len:       usize,
    tdx_quote_hex:       String,
}
```

This `DailyLedgerExport` provides everything required for an audit. The `transactions` array allows for independent recalculation of the state, while the 1024-byte `tdx_quote_hex` provides the hardware verification.

When this hex string is fed into a zkVM like SP1, the system mathematically verifies Intel's signature. It proves with absolute cryptographic certainty that the Rust binary executed inside a secure silicon boundary, the memory was not tampered with, and the resulting state root is accurate. Bypassing the standard C libraries in favor of a direct `ioctl` implementation provided a cleaner, more isolated architecture to achieve this.
